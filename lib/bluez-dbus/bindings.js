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

const {createBluetooth, Adapter} = require('node-ble');
const AsyncQueue = require('./queue.js');
const {bluetooth, destroy} = createBluetooth();

const util = require('util');
const events = require('events');

const debug = require('debug')('bluez-dbus-bindings');

function packUUID(uuid) {
    var result = uuid.replace(/-/g, "").toLowerCase();
    //debug(`packUUID: input = ${uuid}, output = ${result}`);
    return result;
}

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
    //debug(`unpackUUID: input = ${uuid}, output = ${result}`);
    return result;
}

const NobleBindings = function () {
    // node-ble Bluetooth adapter
    this._adapter = null;

    // TODO
    this._device_by_uuid = {};

    // A list of service UUIDs to look for when discovering peripherals.
    // If not empty, only peripherals having one of those service UUIDs
    // will be returned during discovery.
    this._serviceUuidFilterList = [];

    // 
    this._discoveryProcessId = null;

    // How long to wait before querying the adapter for the discovered devices
    this._discoveryProcessDuration = 2000;

    this._gattServerDiscoveryTimeout = 1000;
};
util.inherits(NobleBindings, events.EventEmitter);

NobleBindings.prototype.setScanParameters = function (interval, window) {
    debug(`setScanParameters(${interval}, ${window})`);
};

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

NobleBindings.prototype.onOpen = function () {
    debug('onOpen()');
};

NobleBindings.prototype.onClose = function () {
    debug('onClose()');

    this.emit('stateChange', 'poweredOff');
};

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
                this._discoveryProcessId = setTimeout(this._scanningDurationElapsed.bind(this), this._discoveryProcessDuration);
            }).catch((e) => {
                debug("call to startDiscovery failed", e)
            });
        }
    })
    .catch((e) => {
        debug("call to isDiscovering failed", e)
    });
};

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

// function timeout(ms, messageErreur) {
//     return new Promise((resolve, reject) => {
//         setTimeout(() => {
//             reject(new Error(messageErreur));
//         }, ms);
//     });
// }

// TODO: rename as "discover advertisements data" ?
NobleBindings.prototype._fillupDeviceObject = async function (address) {
    //debug(`_fillupDeviceObject(${address})`);

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
    } catch (e) {
        //debug(`bleDevice.getName() of ${address} failed`, e)
    }

    try {
        var manufacturerAdvertisementData = await bleDevice.getManufacturerAdvertisementData();
        var manufacturers = Object.keys(manufacturerAdvertisementData);
        if (manufacturers.length > 0) {
            var manufacturerAdvertisementData0 = manufacturerAdvertisementData[manufacturers[0]];
            if (typeof manufacturerAdvertisementData0 == "object" && manufacturerAdvertisementData0.signature == "ay") {
                // Reconstruct the original advertising data
                var buffer = Buffer.alloc(manufacturerAdvertisementData0.value.length + 2, 0);
                buffer.writeUInt16LE(Number.parseInt(manufacturers[0]), 0);
                buffer.fill(manufacturerAdvertisementData0.value, 2);
                deviceData.advertisement.manufacturerData = buffer;
            }
        }
        deviceData.manufacturerAdvertisementData = manufacturerAdvertisementData;
    } catch (e) {
        //debug(`bleDevice.getManufacturerAdvertisementData() of ${address} failed`, e)
    }

    try {
        var serviceAdvertisementData = await bleDevice.getServiceAdvertisementData();
        var services = Object.keys(serviceAdvertisementData);
        for (i in services) {
            deviceData.advertisement.serviceData.push({ uuid: packUUID(services[i]), data: serviceAdvertisementData[services[i]] });
        }
        deviceData.serviceAdvertisementData = serviceAdvertisementData;
    } catch (e) {
        //debug(`bleDevice.getServiceAdvertisementData() of ${address} failed`, e)
    }

    try {
        var serviceUUIDs = await bleDevice.getServiceUUIDs();
        deviceData.serviceUuids = serviceUUIDs;
        deviceData.advertisement.serviceUuids = serviceUUIDs.map((uuid) => packUUID(uuid));
    } catch (e) {
        //debug(`bleDevice.getServiceUUIDs() of ${address} failed`, e)
    }

    return deviceData;
}

// TODO: rename as "has advertised criteria" ?
NobleBindings.prototype._hasWantedService = function (device) {
    //debug(`_hasWantedService(${device.uuid})`);

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

    //debug(`<-- _hasWantedService(${device.uuid}) = ${found}`);
    return found;
};

NobleBindings.prototype._scanningDurationElapsed = function () {
    //debug('_scanningDurationElapsed');

    this._adapter.devices().then((devices) => {
        devices.forEach(address => {
            var uuid = this._adapter.constructor.serializeUUID(address);

            if (this._device_by_uuid[uuid] !== undefined) {
                // Discovered device has already been seen
                return;
            }

            this._fillupDeviceObject(address)
                .then((device) => {
                    var name = device.localName != null ? `device ${device.localName}` : "unnamed device";
                    if (this._hasWantedService(device)) {
                        if (this._device_by_uuid[uuid] === undefined) {
                            //debug(device);
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
                    debug('call to _fillupDeviceObject failed', e);
                });
        });
    })
    .catch((e) => {
        debug('call to devices failed', e);
    })
    .finally(() => {
        this._discoveryProcessId = setTimeout(this._scanningDurationElapsed.bind(this), this._discoveryProcessDuration);
    });
};

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

NobleBindings.prototype.cancelConnect = function (deviceUuid) {
    debug(`cancelConnect(${deviceUuid}) is NOT IMPLEMENTED`);
};

NobleBindings.prototype.reset = function () {
    debug(`reset(${deviceUuid}) is NOT IMPLEMENTED`);
};

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

NobleBindings.prototype.updateRssi = function (deviceUuid) {
    debug(`updateRssi(${deviceUuid}) is NOT IMPLEMENTED`);
};

NobleBindings.prototype.addService = function (deviceUuid, service) {
    debug(`addService(${deviceUuid}, ${service}) is NOT IMPLEMENTED`);
};

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

NobleBindings.prototype.discoverIncludedServices = function (deviceUuid, serviceUuid, serviceUuids) {
    debug(`discoverIncludedServices(${deviceUuid}, ${serviceUuid}, ${serviceUuids}) is NOT IMPLEMENTED`);
};

NobleBindings.prototype.addCharacteristics = function (deviceUuid, serviceUuid, characteristics) {
    debug(`addCharacteristics(${deviceUuid}, ${serviceUuid}, ${characteristics}) is NOT IMPLEMENTED`);
};

const characteristicMapping = {
    'read': "read",
    'write-without-response': "writeWithoutResponse",
    'write': "write",
    'notify': "notify"
};

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
            readQueue: new AsyncQueue(),
            writeQueue: new AsyncQueue(),
        };
        //debug(characteristicInfo);
        discoveredCharacteristics.push(characteristicInfo);
    }
    return { characteristics: discoveredCharacteristics, cacheEntry: characteristicCacheEntry };
};

NobleBindings.prototype.discoverCharacteristics = function (deviceUuid, serviceUuid, characteristicUuids) {
    debug(`discoverCharacteristics(${deviceUuid}, ${serviceUuid}, ${characteristicUuids})`);
    if (this._device_by_uuid[deviceUuid] === undefined) {
        return new Promise((resolve, reject) => {
            debug(`<-- discoverCharacteristics(${deviceUuid}, ${serviceUuid}, ${characteristicUuids}): Unknown device`);
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

NobleBindings.prototype._getCharacteristic = function (deviceUuid, serviceUuid, characteristicUuid) {
    debug(`_getCharacteristic(${deviceUuid}, ${serviceUuid}, ${characteristicUuid})`);
    if (this._device_by_uuid[deviceUuid] === undefined) {
        return null;
    }
    
    var device = this._device_by_uuid[deviceUuid];
    if (typeof device.cachedCharacteristics[unpackUUID(serviceUuid)] === undefined) {
        return null;
    }

    return device.cachedCharacteristics[unpackUUID(serviceUuid)][unpackUUID(characteristicUuid)];
};

// serviceUuid needs to be unpacked
NobleBindings.prototype._getPrimaryService = function (deviceUuid, serviceUuid) {
    debug(`--> _getPrimaryService(${deviceUuid}, ${serviceUuid})`);

    if (this._device_by_uuid[deviceUuid] === undefined) {
        return new Promise((resolve, reject) => {
            debug(`<-- _getPrimaryService(${deviceUuid}, ${serviceUuid}): Unknown device`);
            reject(`Unknown device UUID ${deviceUuid}`);
        });
    }
    var device = this._device_by_uuid[deviceUuid];

    if (device.cachedServices[serviceUuid]) {
        return new Promise((resolve, reject) => {
            debug(`<-- _getPrimaryService(${deviceUuid}, ${serviceUuid}): cached`);
            resolve(device.cachedServices[serviceUuid]);
        });
    }
    
    return device.gattServer.getPrimaryService(serviceUuid).then(service => {
        debug(`<-- _getPrimaryService(${deviceUuid}, ${serviceUuid}): new service`);
        device.cachedServices[serviceUuid] = service;
        return service;
    });
};

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

NobleBindings.prototype.broadcast = function (deviceUuid, serviceUuid, characteristicUuid, broadcast) {
    debug(`broadcast(${deviceUuid}, ${serviceUuid}, ${characteristicUuid}, ${broadcast}) is NOT IMPLEMENTED`);
};

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

NobleBindings.prototype.onNotify = function (deviceUuid, serviceUuid, characteristicUuid, e) {
    debug(`onNotify(${deviceUuid}, ${serviceUuid}, ${characteristicUuid}, ${e?.length} bytes)`);
    this.emit('read', deviceUuid, serviceUuid, characteristicUuid, e, true);
};

NobleBindings.prototype.discoverDescriptors = function (deviceUuid, serviceUuid, characteristicUuid) {
    debug(`discoverDescriptors(${deviceUuid}, ${serviceUuid}, ${characteristicUuid}) is NOT IMPLEMENTED`);
};

NobleBindings.prototype.readValue = function (deviceUuid, serviceUuid, characteristicUuid, descriptorUuid) {
    debug(`readValue(${deviceUuid}, ${serviceUuid}, ${characteristicUuid}, ${descriptorUuid}) is NOT IMPLEMENTED`);
};

NobleBindings.prototype.writeValue = function (deviceUuid, serviceUuid, characteristicUuid, descriptorUuid, data) {
    debug(`writeValue(${deviceUuid}, ${serviceUuid}, ${characteristicUuid}, ${descriptorUuid}, ${data}) is NOT IMPLEMENTED`);
};

NobleBindings.prototype.readHandle = function (deviceUuid, handle) {
    debug(`readHandle(${deviceUuid}, ${handle}) is NOT IMPLEMENTED`);
};

NobleBindings.prototype.writeHandle = function (deviceUuid, handle, data, withoutResponse) {
    debug(`writeHandle(${deviceUuid}, ${handle}, ${data}, ${withoutResponse}) is NOT IMPLEMENTED`);
};

module.exports = NobleBindings;
