/**
 * How to use this binding:
 * 
 * - Set the NOBLE_USE_BLUEZ_WITH_DBUS environment variable to "true"
 * - Create the file /etc/dbus-1/system.d/node-ble.conf with the following content:
 * 
 * ```xml
 * <!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-BUS Bus Configuration 1.0//EN"
 *   "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
 * <busconfig>
 *   <policy user="john"> <!-- replace john by the username of the user running noble -->
 *    <allow own="org.bluez"/>
 *     <allow send_destination="org.bluez"/>
 *     <allow send_interface="org.bluez.GattCharacteristic1"/>
 *     <allow send_interface="org.bluez.GattDescriptor1"/>
 *     <allow send_interface="org.freedesktop.DBus.ObjectManager"/>
 *     <allow send_interface="org.freedesktop.DBus.Properties"/>
 *   </policy>
 * </busconfig>
 * ```
 * 
 * How to debug:
 * 
 * ```sh
 * export DEBUG="bluez-dbus-bindings"
 * node test.js
 * ```
 */

// node-ble is the library used to communicate with DBUS API of BlueZ under Linux
const {createBluetooth, Adapter} = require('node-ble');
const {bluetooth, destroy} = createBluetooth();

// Queues are used to serialize all read and write operations on characteristics since
// the BlueZ DBUS API can only handle one read and one write operation at the same time.
const AsyncQueue = require('./queue.js');

// Misc. packages
const util = require('util');
const events = require('events');
const debug = require('debug')('bluez-dbus-bindings');

/**
 * Transforms the textual representation of a 128-bits UUID into a Noble identifier.
 *
 * @param {string} uuid The UUID to pack
 * @returns {string} The packed UUID
 */
function packUUID(uuid) {
    var result = uuid.replace(/-/g, "").toLowerCase();
    return result;
}

/**
 * Transforms a Noble identifier into the textual representation of a 128-bits UUID.
 *
 * @param {*} uuid The UUID to unpack
 * @returns {string} The unpacked UUID
 */
function unpackUUID(uuid) {
    var result = null;
    if (uuid.length == 32) {
        // Split UUID into groups
        var parts = [
            uuid.slice(0, 8),
            uuid.slice(8, 12),
            uuid.slice(12, 16),
            uuid.slice(16, 20),
            uuid.slice(20, 32)
        ];
        result = parts.join("-").toLowerCase();
    } else {
        // Already unpacked
        result = uuid.toLowerCase();
    }
    return result;
}

/**
 * Creates a NobleBindings object.
 */
const NobleBindings = function () {
    // node-ble Bluetooth adapter
    this._adapter = null;

    // Stores all Bluetooth devices discovered, indexed by their BlueZ identifier
    this._device_by_uuid = {};

    // A list of service UUIDs to look for when discovering peripherals.
    // If not empty, only peripherals having one of those service UUIDs
    // will be returned during discovery.
    this._serviceUuidFilterList = [];

    // Identifier of the discovery timeout callback. The identifier is used to call
    // clearTimeout when the discovery is stopped before the callback is called.
    this._discoveryProcessId = null;

    // How long to wait before querying the adapter for the discovered devices
    // The value is currently hardcoded.
    this._discoveryProcessDuration = 2000;

    // How long to wait for the Gatt Server object to appear.
    // The value is currently hardcoded.
    this._gattServerDiscoveryTimeout = 1000;
};
util.inherits(NobleBindings, events.EventEmitter);

/**
 * Initializes this noble binding with default parameters.
 */
NobleBindings.prototype.init = function () {
    debug('init()');
    bluetooth.defaultAdapter().then((result) => {
        debug(`Using default adapter ${result.adapter}`);
        this._adapter = result;
        this.emit('stateChange', 'poweredOn');
    })
    .catch((e) => {
        debug("call to defaultAdapter failed", e)
    });
};

/**
 * Starts searching for Bluetooth devices.
 *
 * @param {object} options scanning options as key/value pairs.
 * @param {boolean} allowDuplicates whether to allow for duplicates
 */
NobleBindings.prototype.startScanning = function (options, allowDuplicates) {
    debug(`startScanning(options = ${options}, allowDuplicates = ${allowDuplicates})`);

    if (Array.isArray(options)) {
        options = { services: options };
    }
    if (typeof options !== 'object') {
        options = { services: options };
    }
    if (options.services !== undefined && !Array.isArray(options.services)) {
        options.services = [options.services];
    }
    options.services = options.services.map((uuid) => packUUID(uuid));

    debug("Processed options: ", options);

    this._adapter.isDiscovering().then((discovering) => {
        if (!discovering) {
            if (Array.isArray(options.services)) {
                this._serviceUuidFilterList = options.services;
            }
            this._adapter.startDiscovery().then(() => {
                this.emit('scanStart');
                if (this._discoveryProcessId != null) {
                    clearTimeout(this._discoveryProcessId);
                }
                this._discoveryProcessId = setTimeout(this._onScanningDurationElapsed.bind(this), this._discoveryProcessDuration);
            }).catch((e) => {
                debug("call to startDiscovery failed", e)
            });
        }
    })
    .catch((e) => {
        debug("call to isDiscovering failed", e)
    });
};

/**
 * Stops searching for Bluetooth devices.
 */
NobleBindings.prototype.stopScanning = function () {
    this._adapter.isDiscovering().then((discovering) => {
        if (discovering) {
            this._adapter.stopDiscovery().then(() => {
                this.emit('scanStop');
                this._device_by_address = {}; // clear cache
                if (this._discoveryProcessId != null) {
                    clearTimeout(this._discoveryProcessId);
                    this._discoveryProcessId = null;
                }
            }).catch((e) => {
                debug("call to stopDiscovery failed", e)
            });
        }
    })
    .catch((e) => {
        debug("call to isDiscovering failed", e)
    });
};

/**
 * Returns advertisement data of the bluetooth device.
 *
 * @param {string} address BlueZ identifier of the device
 * @returns {object} advertisement data
 */
NobleBindings.prototype._getAdvertisementData = async function (address) {
    var bleDevice = await this._adapter.getDevice(address);
    var deviceData = {
        uuid: bleDevice.device,
        address: await bleDevice.getAddress(),
        addressType: await bleDevice.getAddressType(),
        bleDevice: bleDevice,
        paired: await bleDevice.isPaired(),
        cachedServices: {},
        advertisement: {
            txPowerLevel: undefined,
            serviceUuids: [],
            serviceData: []
        },
    };

    try {
        var localName = await bleDevice.getName();
        deviceData.localName = localName;
        deviceData.advertisement.localName = localName;
    } catch (e) { }

    try {
        var manufacturerAdvertisementData = await bleDevice.getManufacturerAdvertisementData();
        var manufacturers = Object.keys(manufacturerAdvertisementData);
        if (manufacturers.length > 0) {
            var manufacturerAdvertisementData0 = manufacturerAdvertisementData[manufacturers[0]];
            if (typeof manufacturerAdvertisementData0 == "object" && manufacturerAdvertisementData0.signature == "ay") {
                // The BlueZ DBUS API decoded the Manufacturer Advertisement data
                // We need to reconstruct the original advertising data to be compliant
                // with what noble clients expect.
                var buffer = Buffer.alloc(manufacturerAdvertisementData0.value.length + 2, 0);
                buffer.writeUInt16LE(Number.parseInt(manufacturers[0]), 0);
                buffer.fill(manufacturerAdvertisementData0.value, 2);
                deviceData.advertisement.manufacturerData = buffer;
            }
        }
        deviceData.manufacturerAdvertisementData = manufacturerAdvertisementData;
    } catch (e) { }

    try {
        var serviceAdvertisementData = await bleDevice.getServiceAdvertisementData();
        var services = Object.keys(serviceAdvertisementData);
        for (i in services) {
            deviceData.advertisement.serviceData.push({ uuid: packUUID(services[i]), data: serviceAdvertisementData[services[i]] });
        }
        deviceData.serviceAdvertisementData = serviceAdvertisementData;
    } catch (e) { }

    try {
        var serviceUUIDs = await bleDevice.getServiceUUIDs();
        deviceData.serviceUuids = serviceUUIDs;
        deviceData.advertisement.serviceUuids = serviceUUIDs.map((uuid) => packUUID(uuid));
    } catch (e) { }

    return deviceData;
}

/**
 * Checks if the device is advertising the wanted service UUIDs (the "services"
 * option passed to the init() function).
 *
 * @param {string} device BlueZ identifier of the device
 * @returns {boolean} whether the device is advertising the wanted criteria
 */
NobleBindings.prototype._isAdvertisingWantedCriteria = function (device) {
    if (this._serviceUuidFilterList.length === 0) {
        // When the filter lists are empty, no filter is applied
        return true;
    }

    var found = false;
    if (this._serviceUuidFilterList.length !== 0 && device.advertisement.serviceUuids !== undefined && Array.isArray(device.advertisement.serviceUuids)) {
        for (i in device.serviceUuids) {
            found ||= this._serviceUuidFilterList.indexOf(device.advertisement.serviceUuids[i]) !== -1;
            if (found) {
                break;
            }
        }
    }

    return found;
};

/**
 * _onScanningDurationElapsed is called peridically during the scanning process to
 * process discovered devices and emit the "discover" event if the discovered device
 * advertises the wanted service UUIDs.
 */
NobleBindings.prototype._onScanningDurationElapsed = function () {
    this._adapter.devices().then((devices) => {
        devices.forEach(address => {
            var uuid = this._adapter.constructor.serializeUUID(address);

            if (this._device_by_uuid[uuid] !== undefined) {
                // Discovered device has already been seen
                return;
            }

            this._getAdvertisementData(address)
                .then((device) => {
                    var name = device.localName != null ? `device ${device.localName}` : "unnamed device";
                    if (this._isAdvertisingWantedCriteria(device)) {
                        if (this._device_by_uuid[uuid] === undefined) {
                            debug(`discovered ${name} (${device.address})`);
                            this._device_by_uuid[uuid] = device;
                            this.emit('discover', device.uuid, device.address, device.addressType, !device.paired, device.advertisement, device.rssi, device.gatt !== undefined);
                        }
                    } else {
                        debug(`discarded ${name} (${device.address})`);

                        // Free up resources 
                        delete device.bleDevice;
                    }

                    // Add discovered devices in the cache so that we do not need to scan them again
                    this._device_by_uuid[uuid] = device;
                })
                .catch((e) => {
                    debug('call to _getAdvertisementData failed', e);
                });
        });
    })
    .catch((e) => {
        debug('call to devices failed', e);
    })
    .finally(() => {
        if (this._discoveryProcessId != null) {
            // If the scanning process is still on going, schedule a new callback execution to collect results.
            this._discoveryProcessId = setTimeout(this._onScanningDurationElapsed.bind(this), this._discoveryProcessDuration);
        }
    });
};

/**
 * Connects to a Bluetooth device.
 *
 * @param {string} deviceUuid BlueZ identifier of the device
 * @param {object} parameters currently unused
 */
NobleBindings.prototype.connect = function (deviceUuid, parameters) {
    debug(`connect(${deviceUuid}, parameters = ${parameters})`);
    if (this._device_by_uuid[deviceUuid] === undefined) {
        return;
    }
    var device = this._device_by_uuid[deviceUuid];
    device.bleDevice.on('connect', this.onConnect.bind(this));
    device.bleDevice.on('disconnect', this.onDisconnect.bind(this));
    
    device.bleDevice.isConnected().then((connected) => {
        if (connected) {
            this.emit('connect', deviceUuid);
        } else {
            device.bleDevice.connect();
        }
    });
};

/**
 * onConnect is called when a connection to a Bluetooth device is established.
 *
 * @param {object} e the Event object
 */
NobleBindings.prototype.onConnect = function (e) {
    debug(`onConnect(${e.deviceUuid})`);
    if (this._device_by_uuid[e.deviceUuid] === undefined) {
        return;
    }
    var device = this._device_by_uuid[e.deviceUuid];
    device.cachedServices = {};
    device.cachedCharacteristics = {};
    this.emit('connect', e.deviceUuid);
};

/**
 * onDisconnect is called when a connection with a Bluetooth device is stopped.
 *
 * @param {object} e the Event object
 */
NobleBindings.prototype.onDisconnect = function (e) {
    debug(`onDisconnect(${e.deviceUuid})`);
    if (this._device_by_uuid[e.deviceUuid] === undefined) {
        return;
    }
    var device = this._device_by_uuid[e.deviceUuid];
    device.cachedServices = {};
    device.cachedCharacteristics = {};
    this.emit('disconnect', e.deviceUuid);
};

/**
 * Disconnects from a bluetooth device.
 *
 * @param {string} deviceUuid BlueZ identifier of the device
 */
NobleBindings.prototype.disconnect = function (deviceUuid) {
    debug(`disconnect(${deviceUuid})`);
    if (this._device_by_uuid[deviceUuid] === undefined) {
        return;
    }
    var device = this._device_by_uuid[deviceUuid];
    device.bleDevice.isConnected().then((connected) => {
        if (!connected) {
            this.emit('disconnect', deviceUuid);
        } else {
            device.bleDevice.disconnect();
            delete device.gattServer;
        }
    });
};

/**
 * Discovers GATT services exposed by the bluetooth device.
 *
 * @param {string} deviceUuid BlueZ identifier of the device
 * @param {*} uuids currently unused
 */
NobleBindings.prototype.discoverServices = function (deviceUuid, uuids) {
    debug(`discoverServices(${deviceUuid}, ${uuids})`);
    if (this._device_by_uuid[deviceUuid] === undefined) {
        return;
    }
    var device = this._device_by_uuid[deviceUuid];
    device.bleDevice.gatt().then((gatt) => {
        device.gattServer = gatt;
        gatt.services().then((services) => {
            device.serviceUuids = services;
            this.emit('servicesDiscover', deviceUuid, services.map((uuid) => packUUID(uuid)));
        }).catch((e) => {
            debug("Call to gatt.services() failed", e);
        });
    }).catch((e) => {
        debug("Call to device.gatt() failed", e);
    });
};

//
// Maps GATT Characteristics information from the BlueZ format to the Noble format.
//
const characteristicMapping = {
    'read': "read",
    'write-without-response': "writeWithoutResponse",
    'write': "write",
    'notify': "notify"
};

/**
 * Iterates over all characteristics of a GATT service.
 *
 * @param {object} service node-ble GATT service object
 * @returns {object} object containing two keys: "characteristics" (discovered characteristics)
 *                   and "cacheEntry" (the entry to insert into the discovered characteristics
 *                   cache of the service).
 */
NobleBindings.prototype._discoverServiceCharacteristics = async function (service) {
    var characteristicUuids = await service.characteristics();
    var discoveredCharacteristics = [];
    var characteristicCacheEntry = {};
    for (i in characteristicUuids) {
        var characteristicUuid = characteristicUuids[i];
        var characteristic = await service.getCharacteristic(characteristicUuid);
        const characteristicInfo = { uuid: packUUID(characteristicUuid), properties: [] };
        var flags = await characteristic.getFlags();
        const allCharacteristics = Object.keys(characteristicMapping);
        for (j in allCharacteristics) {
            const characteristicName = allCharacteristics[j];
            if (flags.indexOf(characteristicName) !== -1) {
                characteristicInfo.properties.push(characteristicMapping[characteristicName]);
            }
        }
        characteristicCacheEntry[characteristicUuid] = {
            characteristic: characteristic,

            // The following two queues are needed to process read and write operations
            // one after the other.
            //
            // This is needed because the BlueZ DBUS API can handle only one read and one
            // write ongoing operation for each characteristic at a time.
            readQueue: new AsyncQueue(),
            writeQueue: new AsyncQueue(),
        };
        discoveredCharacteristics.push(characteristicInfo);
    }
    return { characteristics: discoveredCharacteristics, cacheEntry: characteristicCacheEntry };
};

/**
 * Discovers characteristics of a GATT service.
 *
 * @param {string} deviceUuid BlueZ identifier of the device
 * @param {string} serviceUuid the GATT service UUID
 * @param {*} characteristicUuids currently unused
 */
NobleBindings.prototype.discoverCharacteristics = function (deviceUuid, serviceUuid, characteristicUuids) {
    debug(`discoverCharacteristics(${deviceUuid}, ${serviceUuid}, ${characteristicUuids})`);
    if (this._device_by_uuid[deviceUuid] === undefined) {
        return new Promise((resolve, reject) => {
            debug(`discoverCharacteristics(${deviceUuid}, ${serviceUuid}, ${characteristicUuids}): Unknown device`);
            reject(`Unknown device UUID ${deviceUuid}`);
        });
    }
    var device = this._device_by_uuid[deviceUuid];
    this._getPrimaryService(deviceUuid, unpackUUID(serviceUuid)).then((gattService) => {
        this._discoverServiceCharacteristics(gattService).then((discoveredCharacteristics) => {
            device.cachedCharacteristics[unpackUUID(serviceUuid)] = discoveredCharacteristics.cacheEntry;
            this.emit('characteristicsDiscover', deviceUuid, serviceUuid, discoveredCharacteristics.characteristics);
        })
        .catch((e) => {
            debug("Call to this._discoverServiceCharacteristics failed", e);
        })
    })
    .catch((e) => {
        debug("Call to this._getPrimaryService failed", e);
    });
};

/**
 * Returns the cache entry of a GATT characteristic.
 *
 * @param {string} deviceUuid BlueZ identifier of the device
 * @param {string} serviceUuid the GATT service UUID
 * @param {string} characteristicUuid the GATT characteristic UUID
 * @returns {object} the cache entry as returned by _discoverServiceCharacteristics()
 */
NobleBindings.prototype._getCharacteristic = function (deviceUuid, serviceUuid, characteristicUuid) {
    if (this._device_by_uuid[deviceUuid] === undefined) {
        return null;
    }
    
    var device = this._device_by_uuid[deviceUuid];
    if (typeof device.cachedCharacteristics[unpackUUID(serviceUuid)] === undefined) {
        return null;
    }

    return device.cachedCharacteristics[unpackUUID(serviceUuid)][unpackUUID(characteristicUuid)];
};

/**
 * Returns the primary GATT service designated by its UUID by:
 * - returning the result from the cache if found,
 * - using the node-ble library and caching the result for later use, if not.
 *
 * @param {*} deviceUuid BlueZ identifier of the device
 * @param {*} serviceUuid the GATT service UUID
 * @returns {Promise} a promise resolving to a "GattService" object from the node-ble library
 */
NobleBindings.prototype._getPrimaryService = function (deviceUuid, serviceUuid) {
    if (this._device_by_uuid[deviceUuid] === undefined) {
        return new Promise((resolve, reject) => {
            reject(`Unknown device UUID ${deviceUuid}`);
        });
    }
    var device = this._device_by_uuid[deviceUuid];

    if (device.cachedServices[serviceUuid]) {
        return new Promise((resolve, reject) => {
            resolve(device.cachedServices[serviceUuid]);
        });
    }
    
    return device.gattServer.getPrimaryService(serviceUuid).then(service => {
        device.cachedServices[serviceUuid] = service;
        return service;
    });
};

/**
 * Reads data from a GATT characteristic.
 *
 * @param {string} deviceUuid BlueZ identifier of the device
 * @param {string} serviceUuid the GATT service UUID
 * @param {string} characteristicUuid the GATT characteristic UUID
 */
NobleBindings.prototype.read = function (deviceUuid, serviceUuid, characteristicUuid) {
    debug(`read(${deviceUuid}, ${serviceUuid}, ${characteristicUuid})`);
    
    var characteristic = this._getCharacteristic(deviceUuid, serviceUuid, characteristicUuid);
    if (characteristic == null) {
        return;
    }

    characteristic.readQueue.enqueue(async () => {
        var data
        try {
            var data = await characteristic.characteristic.readValue();
            debug(`Read ${data.length} bytes from device = ${deviceUuid}, service = ${serviceUuid}, characteristic = ${characteristicUuid}`);
            this.emit('read', deviceUuid, serviceUuid, characteristicUuid, data, false);
        } catch (e) {
            debug("Call to characteristic.readValue failed", e);
        }
    });
};

/**
 * Writes data to a GATT characteristic.
 *
 * @param {string} deviceUuid BlueZ identifier of the device
 * @param {string} serviceUuid the GATT service UUID
 * @param {string} characteristicUuid the GATT characteristic UUID
 */
NobleBindings.prototype.write = function (deviceUuid, serviceUuid, characteristicUuid, data, withoutResponse) {
    debug(`write(${deviceUuid}, ${serviceUuid}, ${characteristicUuid}, ${data?.length} bytes, ${withoutResponse})`);

    var characteristic = this._getCharacteristic(deviceUuid, serviceUuid, characteristicUuid);
    if (characteristic == null) {
        return;
    }

    characteristic.writeQueue.enqueue(async () => {
        try {
            var options = { offset: 0, type: (withoutResponse ? 'command' : 'request') };
            await characteristic.characteristic.writeValue(data, options);
            debug(`Wrote ${data.length} bytes to device = ${deviceUuid}, service = ${serviceUuid}, characteristic = ${characteristicUuid}`);
            this.emit('write', deviceUuid, serviceUuid, characteristicUuid);
        } catch (e) {
            debug(`Call to characteristic.writeValue failed`, e);
        }
    });
};

/**
 * Enables or disables value change notifications on a GATT characteristic.
 *
 * @param {string} deviceUuid BlueZ identifier of the device
 * @param {string} serviceUuid the GATT service UUID
 * @param {string} characteristicUuid the GATT characteristic UUID
 * @param {boolean} notify whether to enable or disable change notifications
 */
NobleBindings.prototype.notify = function (deviceUuid, serviceUuid, characteristicUuid, notify) {
    debug(`notify(${deviceUuid}, ${serviceUuid}, ${characteristicUuid}, ${notify})`);

    var characteristic = this._getCharacteristic(deviceUuid, serviceUuid, characteristicUuid);
    if (characteristic == null) {
        return;
    }

    if (notify) {
        characteristic.characteristic.on("valuechanged", (e) => {
            this.onNotify(deviceUuid, serviceUuid, characteristicUuid, e);
        });
        characteristic.characteristic.startNotifications().then(() => {
            debug(`Notifications have been enabled for device = ${deviceUuid}, service = ${serviceUuid}, characteristic = ${characteristicUuid}`);
            this.emit('notify', deviceUuid, serviceUuid, characteristicUuid, true);
        })
        .catch((e) => {
            debug("Call to characteristic.startNotifications failed", e);
        });
    } else {
        characteristic.characteristic.removeAllListeners("valuechanged");
        debug(`Notifications have been disabled for device = ${deviceUuid}, service = ${serviceUuid}, characteristic = ${characteristicUuid}`);
        characteristic.characteristic.stopNotifications().then(() => {
            this.emit('notify', deviceUuid, serviceUuid, characteristicUuid, false);
        })
        .catch((e) => {
            debug("Call to characteristic.stopNotifications failed", e);
        });
    }
};

/**
 * onNotify is called when a value changed on a GATT characteristic.
 *
 * @param {string} deviceUuid BlueZ identifier of the device
 * @param {string} serviceUuid the GATT service UUID
 * @param {string} characteristicUuid the GATT characteristic UUID
 * @param {object} e the Event object
 */
NobleBindings.prototype.onNotify = function (deviceUuid, serviceUuid, characteristicUuid, e) {
    debug(`onNotify(${deviceUuid}, ${serviceUuid}, ${characteristicUuid}, ${e?.length} bytes)`);
    this.emit('read', deviceUuid, serviceUuid, characteristicUuid, e, true);
};

/**
 * NOT IMPLEMENTED
 */
NobleBindings.prototype.discoverIncludedServices = function (deviceUuid, serviceUuid, serviceUuids) {
    debug(`discoverIncludedServices(${deviceUuid}, ${serviceUuid}, ${serviceUuids}) is NOT IMPLEMENTED`);
};

/**
 * NOT IMPLEMENTED
 */
NobleBindings.prototype.addCharacteristics = function (deviceUuid, serviceUuid, characteristics) {
    debug(`addCharacteristics(${deviceUuid}, ${serviceUuid}, ${characteristics}) is NOT IMPLEMENTED`);
};

/**
 * NOT IMPLEMENTED
 */
NobleBindings.prototype.broadcast = function (deviceUuid, serviceUuid, characteristicUuid, broadcast) {
    debug(`broadcast(${deviceUuid}, ${serviceUuid}, ${characteristicUuid}, ${broadcast}) is NOT IMPLEMENTED`);
};

/**
 * NOT IMPLEMENTED
 */
NobleBindings.prototype.updateRssi = function (deviceUuid) {
    debug(`updateRssi(${deviceUuid}) is NOT IMPLEMENTED`);
};

/**
 * NOT IMPLEMENTED
 */
NobleBindings.prototype.addService = function (deviceUuid, service) {
    debug(`addService(${deviceUuid}, ${service}) is NOT IMPLEMENTED`);
};

/**
 * NOT IMPLEMENTED
 */
NobleBindings.prototype.cancelConnect = function (deviceUuid) {
    debug(`cancelConnect(${deviceUuid}) is NOT IMPLEMENTED`);
};

/**
 * NOT IMPLEMENTED
 */
NobleBindings.prototype.reset = function () {
    debug(`reset(${deviceUuid}) is NOT IMPLEMENTED`);
};

/**
 * NOT IMPLEMENTED
 */
NobleBindings.prototype.discoverDescriptors = function (deviceUuid, serviceUuid, characteristicUuid) {
    debug(`discoverDescriptors(${deviceUuid}, ${serviceUuid}, ${characteristicUuid}) is NOT IMPLEMENTED`);
};

/**
 * NOT IMPLEMENTED
 */
NobleBindings.prototype.readValue = function (deviceUuid, serviceUuid, characteristicUuid, descriptorUuid) {
    debug(`readValue(${deviceUuid}, ${serviceUuid}, ${characteristicUuid}, ${descriptorUuid}) is NOT IMPLEMENTED`);
};

/**
 * NOT IMPLEMENTED
 */
NobleBindings.prototype.writeValue = function (deviceUuid, serviceUuid, characteristicUuid, descriptorUuid, data) {
    debug(`writeValue(${deviceUuid}, ${serviceUuid}, ${characteristicUuid}, ${descriptorUuid}, ${data}) is NOT IMPLEMENTED`);
};

/**
 * NOT IMPLEMENTED
 */
NobleBindings.prototype.readHandle = function (deviceUuid, handle) {
    debug(`readHandle(${deviceUuid}, ${handle}) is NOT IMPLEMENTED`);
};

/**
 * NOT IMPLEMENTED
 */
NobleBindings.prototype.writeHandle = function (deviceUuid, handle, data, withoutResponse) {
    debug(`writeHandle(${deviceUuid}, ${handle}, ${data}, ${withoutResponse}) is NOT IMPLEMENTED`);
};

module.exports = NobleBindings;
