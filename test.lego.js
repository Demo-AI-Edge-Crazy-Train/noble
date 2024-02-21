const noble = require('./index');

noble.on('stateChange', function (state) {
  console.log(`The bluetooth controller is now ${state}.`);

  if (state === 'poweredOn') {
    console.log("Discovering Lego devices...")
    noble.startScanning(["00001623-1212-efde-1623-785feabcd123", "00004f0e-1212-efde-1523-785feabcd123"]);
  } else {
    noble.stopScanning();
  }
});

noble.on('scanStart', function () {
  console.log('Bluetooth discovery process started!');
});

noble.on('scanStop', function () {
  console.log('Bluetooth discovery process stopped!');
});

noble.on('discover', function (peripheral) {
  var name = peripheral.advertisement.localName != null ? peripheral.advertisement.localName : "unknown";
  console.log(`Found Lego device '${name}' with address ${peripheral.address}!`);

  noble.stopScanning();

  peripheral.on('connect', function () {
    console.log(`Connected to device '${name}'!`);

    // Disconnect from device before quitting
    process.on('SIGINT', () => {
      console.log(`Received SIGINT! Disconnecting from device '${name}'...`);
      peripheral.disconnect();
    });

    console.log(`Discovering services on device '${name}'...`);
    this.discoverServices();
  });

  peripheral.on('disconnect', function () {
    console.log(`Disconnected from device '${name}'!`);
    process.exit(1);
  });

  peripheral.on('servicesDiscover', function (services) {
    console.log(`Discovered ${services.length} services on device '${name}'!`);
    //console.log(services);

    const wantedServiceUuids = ["00001523-1212-efde-1523-785feabcd123","00001623-1212-efde-1623-785feabcd123"].map((uuid) => uuid.replace(/-/g, ""));
    services = services.filter((svc) => wantedServiceUuids.indexOf(svc.uuid) !== -1);
    if (services.length == 0) {
      console.log("Cannot find one of the required services !");
      return;
    }

    var service = services[0];
    console.log(`Using service ${service.uuid}!`);

    service.on(
      'characteristicsDiscover',
      function (characteristics) {
        console.log(`Discovered ${characteristics.length} characteristics on service ${service.uuid}!`);
        //console.log(characteristics);

        const wantedCharacteristicUuid = "00001624-1212-efde-1623-785feabcd123".replace(/-/g, "");
        var characteristic = characteristics.find((char) => char.uuid == wantedCharacteristicUuid);
        if (characteristic === undefined) {
          console.log(`Cannot find required characteristic ${wantedCharacteristicUuid} in service ${service.uuid}!`);
          return;
        }
    
        characteristic.on(
          'data',
          function (data, isNotification) {
            console.log(`Read ${data.length} bytes from characteristic ${characteristic.uuid} (notification = ${isNotification}).`);
            console.log(data);

            const len = data[0];
            if (len == 5 && data[2] == 0x05) {
              console.log(`Received generic error ${data[4]} from device!`);
            }
            
            if (len == 6 && data[2] == 0x01 && data[3] == 0x06) {
              const batteryLevel = data[5];
              console.log(`Battery level of '${name}' is ${batteryLevel}`);
            }
          }
        );

        characteristic.on('write', function () {
          console.log(`Wrote data to characteristic ${characteristic.uuid}.`);
        });

        characteristic.on('notify', function (state) {
          console.log(`Notify for characteristic ${characteristic.uuid} is ${state}.`);
          if (state) {
            characteristic.write(Buffer.from([0x05, 0x00, 0x01, 0x06, 0x02]), false);
          }
        });

        characteristic.notify(true);
      }
    );

    service.discoverCharacteristics();
  });

  if (peripheral.state == "connected") {
    console.log(`Discovering services on device '${name}'...`);
    this.discoverServices();
  } else {
    console.log(`Connecting to device '${name}'...`);
    peripheral.connect();
  }
});
