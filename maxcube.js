// Test modif github
var net = require('net');
var schedule = require('node-schedule');
var moment = require('moment');
var fs = require('fs');
var util = require('util');
var sleep = require('sleep');
var EventEmitter = require('events').EventEmitter;

var updateIntervalMins = 15;
var heartbeatIntervalSecs = 20;

// Device types
var EQ3MAX_DEV_TYPE_CUBE = 0;
var EQ3MAX_DEV_TYPE_THERMOSTAT = 1;
var EQ3MAX_DEV_TYPE_THERMOSTAT_PLUS = 2;
var EQ3MAX_DEV_TYPE_WALLTHERMOSTAT = 3;
var EQ3MAX_DEV_TYPE_SHUTTER_CONTACT = 4;
var EQ3MAX_DEV_TYPE_PUSH_BUTTON = 5;

var EQ3MAX_DEV_MODE_AUTO = 0;
var EQ3MAX_DEV_MODE_MANU = 1;
var EQ3MAX_DEV_MODE_VACATION = 2;
var EQ3MAX_DEV_MODE_BOOST = 3;

function padLeft(nr, n, str){
  return Array(n-String(nr).length+1).join(str||'0')+nr;
}

// Constructor
function MaxCube(ip, port) {
  this.ip = ip;
  this.port = port;
  this.debug = 0;

  this.isConnected = false;
  this.busy = false;

  this.callback;
  this.dutyCycle = 0;
  this.memorySlots = 0;

  this.rooms = [];
  this.devices = {};
  this.devicesStatus = {};

  this.client = new net.Socket();
  var self = this;
  this.servercmds = []
  this.server = net.createServer(function(socket) {
    log("Proxy: New socket")
    for (var index in self.servercmds) {
      var line = self.servercmds[index];
      log("Proxy Send: " + line)
      try { socket.write(line + "\r\n") } catch (err) { }
    }
    socket.on('error', function (err) {
    });
    socket.on('data', function(data){
      log("Proxy Recv: " + data.toString('utf-8').replace("\n", "").replace("\r", ""))
      try { if (data.toString('utf-8').replace("\n", "").replace("\r", "") != "q:") self.client.write(data); } catch (err) { }
    });
    self.client.on('data', function(data) {
      log("Proxy Send: " + data.toString('utf-8').replace("\n", "").replace("\r", ""))
      try { socket.write(data); } catch (err) { }
    });
  });
  //this.server.listen(port);

  this.client.on('data', function(dataBuff) {
    lines = dataBuff.toString('utf-8').replace("\r", "").split("\n")
    for (var index in lines) {
      var line = lines[index].replace("\r", "").replace("\n", "")
      if (line != "") {
        var commandType = line.substr(0, 1);
        var payload = line.substring(2, line.length);
        if (this.debug == 0)
          log('Data received: ' + commandType);
        else
          log('Data received: ' + commandType + ' [' + payload + ']');

        var dataObj = parseCommand.call(self, commandType, payload);

        if (self.callback != undefined && self.callback instanceof Function) {
          self.callback.call(self, dataObj);
          self.callback = undefined;
        }
        if (commandType == "H" || commandType == "M") {
          self.servercmds.push(line);
        }
      }
    }
    self.busy = false;
  });

  this.client.on('close', function() {
    log('Connection closed');
  });

  var ruleUpdateTrigger = new schedule.RecurrenceRule();
  // run every 15 mins, first time 8 min after hour
  ruleUpdateTrigger.minute = [new schedule.Range(8, 60, 15)];
  this.updateTriggerJob = schedule.scheduleJob(ruleUpdateTrigger, function(){
    var offset = 0;
    Object.keys(self.devices).forEach(function(rf_address) {
      if (self.devices[rf_address] !== undefined && self.devices[rf_address].devicetype === 1) {
        // TODO: better not use anonymous function? (http://stackoverflow.com/a/5226333)
        (function(rf_address) {
          setTimeout(function() {
            var temp = self.devicesStatus[rf_address] ? self.devicesStatus[rf_address].setpoint_user + 0.5 : 1.5;
            log('Update trigger ' + rf_address);
            setTemperature.call(self, rf_address, 'MANUAL', temp);
          }, offset++ * 15000);
        })(rf_address);
      }
    });
  });

  var ruleUpdateTriggerReset = new schedule.RecurrenceRule();
  ruleUpdateTriggerReset.minute = [new schedule.Range(10, 60, 15)];
  this.updateTriggerResetJob = schedule.scheduleJob(ruleUpdateTriggerReset, function(){
    var offset = 0;
    Object.keys(self.devices).forEach(function(rf_address) {
      if (self.devices[rf_address] !== undefined && self.devices[rf_address].devicetype === 1) {
        (function(rf_address) {
          setTimeout(function() {
            var temp = self.devicesStatus[rf_address] ? self.devicesStatus[rf_address].setpoint_user : 1;
            log('Update trigger reset ' + rf_address);
            setTemperature.call(self, rf_address, 'MANUAL', temp);
          }, offset * 15000);
        })(rf_address);
      }
    });
  });

  var ruleHeartbeat = new schedule.RecurrenceRule();
  ruleHeartbeat.second = [new schedule.Range(heartbeatIntervalSecs/2, 59, heartbeatIntervalSecs)];
  this.heartbeatJob = schedule.scheduleJob(ruleHeartbeat, function(){
    log('Heartbeat');
    doHeartbeat.call(self, function (dataObj) {});
  });

  log('MaxCube initialized on ' + this.ip);

}

util.inherits(MaxCube, EventEmitter);

// class methods
MaxCube.prototype.getDeviceStatus = function(rf_address) {
  return this.devicesStatus[rf_address];
};
MaxCube.prototype.getDevices = function() {
  return this.devices;
};
MaxCube.prototype.getRooms = function() {
  return this.rooms;
};
MaxCube.prototype.close = function() {
  this.client.destroy();
  schedule.cancelJob(this.heartbeatJob);
  schedule.cancelJob(this.updateTriggerResetJob);
  schedule.cancelJob(this.updateTriggerJob);
};
MaxCube.prototype.doBoost = function(rf_address, temperature) {
  return setTemperature.call(this, rf_address, 'BOOST', temperature);
};

MaxCube.prototype.doAuto = function(rf_address, temperature) {
  return setTemperature.call(this, rf_address, 'AUTO', temperature);
};

MaxCube.prototype.send = function(data) {
  var payload = new Buffer(data, 'hex').toString('base64');
  var data = 's:' + payload + '\r\n';
  return send.call(this, data);
};

MaxCube.prototype.setTemperature = function(rf_address, temperature) {
  if (this.devicesStatus[rf_address])
    this.devicesStatus[rf_address].setpoint_user = temperature;
  return setTemperature.call(this, rf_address, 'MANUAL', temperature);
};
MaxCube.prototype.setVacationTemperature = function(rf_address, temperature, untilDate) {
  if (this.devicesStatus[rf_address])
    this.devicesStatus[rf_address].setpoint_user = temperature;
  return setTemperature.call(this, rf_address, 'VACATION', temperature, untilDate);
};

function send (dataStr, callback) {
  if (!this.busy) {
    if (callback !== undefined  && callback instanceof Function) {
      busy = true;
      this.callback = callback;
    } else {
      this.callback = undefined;
    }

    log('Data sent (' + this.dutyCycle + '%, ' + this.memorySlots + '): ' + dataStr.substr(0,1));
    this.client.write(dataStr);
  }
}

function parseCommand (type, payload) {
  switch (type) {
    case 'H':
      return parseCommandHello.call(this, payload);
      break;
    case 'M':
      return parseCommandMetadata.call(this, payload);
      break;
    case 'C':
      return parseCommandConfiguration.call(this, payload);
      break;
    case 'L':
      return parseCommandDeviceList.call(this, payload);
      break;
    case 'S':
      return parseCommandSendDevice.call(this, payload);
      break;
    default:
      log('Unknown command type: ' + type);
  }
}

function parseCommandHello (payload) {
  var payloadArr = payload.split(",");

  var dataObj = {
    serial_number: payloadArr[0],
    rf_address: payloadArr[1],
    firmware_version: payloadArr[2],
    //unknown: payloadArr[3],
    http_connection_id: payloadArr[4],
    duty_cycle: parseInt(payloadArr[5], 16),
    free_memory_slots: parseInt(payloadArr[6], 16),
    cube_date: 2000 + parseInt(payloadArr[7].substr(0, 2), 16) + '-' + parseInt(payloadArr[7].substr(2, 2), 16) + '-' + parseInt(payloadArr[7].substr(4, 2), 16),
    cube_time: parseInt(payloadArr[8].substr(0, 2), 16) + ':' + parseInt(payloadArr[8].substr(2, 2), 16) ,
    state_cube_time: payloadArr[9],
    ntp_counter: payloadArr[10],
  };

  this.dutyCycle = dataObj.duty_cycle;
  this.memorySlots = dataObj.free_memory_slots;

  this.emit('connected', dataObj);

  return dataObj;
}

function parseCommandMetadata (payload) {
  var decodedPayload;
  if ( payload.indexOf(",") == -1 )
    decodedPayload = new Buffer(payload, 'base64');
  else
  { var payloadArr = payload.split(",");
    decodedPayload = new Buffer(payloadArr[2], 'base64');
  }
  var room_count = decodedPayload[2];
  var currentIndex = 3;

  // parse rooms
  for (var i = 0; i < room_count; i++) {
    var room_id = decodedPayload[currentIndex];
    var room_name_length = decodedPayload[currentIndex + 1];
    var room_name = String.fromCharCode.apply(null, decodedPayload.slice(currentIndex + 2, currentIndex + 2 + room_name_length));
    var group_rf_address = decodedPayload.slice(currentIndex + 2 + room_name_length, currentIndex + room_name_length + 5).toString('hex');

    var roomData = {
      room_id: room_id,
      room_name: room_name,
      group_rf_address: group_rf_address
    };
    this.rooms.push(roomData);

    currentIndex = currentIndex + room_name_length + 5;
  };

  // parse devices
  if (currentIndex < decodedPayload.length) {
    var device_count = decodedPayload[currentIndex];
    for (var i = 0; i < device_count; i++) {
      var devicetype = decodedPayload[currentIndex + 1];
      var rf_address = decodedPayload.slice(currentIndex + 2, currentIndex + 5).toString('hex');
      var serialnumber = decodedPayload.slice(currentIndex + 5, currentIndex + 15).toString();
      var device_name_length = decodedPayload[currentIndex + 15];
      var device_name = String.fromCharCode.apply(null, decodedPayload.slice(currentIndex + 16, currentIndex + 16 + device_name_length));
      var room_id = decodedPayload[currentIndex + 16 + device_name_length];

      var deviceData = {
        devicetype: devicetype,
        rf_address: rf_address,
        serialnumber: serialnumber,
        device_name: device_name,
        room_id: room_id,
      };
      this.devices[rf_address] = deviceData;

      currentIndex = currentIndex + 16 + device_name_length;
    }
  }

  this.emit('metadataUpdate', {rooms: this.rooms, devices: this.devices});
}

function parseCommandConfiguration (payload) {
  if (payload.length == 0)
    return;
  /*
  Start Length  Value       Description
  ==================================================================
  00         1  D2          Length of data: D2 = 210(decimal) = 210 bytes
  01         3  003508      RF address
  04         1  01          Device Type
  05         3  0114FF      Room ID, Firmware version, Test Result
  08        10  IEQ0109125  Serial Number
  
  //for EQ3MAX_DEV_TYPE_THERMOSTAT
  18         1  28          Comfort Temperature
  19         1  28          Eco Temperature
  20         1  3D          MaxSetPointTemperature
  21         1  09          MinSetPointTemperature
  22         1  07          Temperature Offset * 2
                            The default value is 3,5, which means the offset = 0 degrees.
                            The offset is adjustable between -3,5 and +3,5 degrees,
                            which results in a value in this response between 0 and 7 (decoded already)
  23         1  28          Window Open Temperature
  24         1  03          Window  Open Duration
  25         1  30          Boost Duration and Boost Valve Value
                            The 3 MSB bits gives the duration, the 5 LSB bits the Valve Value%.
                            Duration: With 3 bits, the possible values (Dec) are 0 to 7, 0 is not used.
                            The duration in Minutes is: if Dec value = 7, then 30 minutes, else Dec value * 5 minutes
                            Valve Value: dec value 5 LSB bits * 5 gives Valve Value in %
  26         1  0C          Decalcification: Day of week and Time
                            In bits: DDDHHHHH
                            The three most significant bits (MSB) are presenting the day, Saturday = 1, Friday = 7
                            The five least significant bits (LSB) are presenting the time (in hours)
  27         1  FF          Maximum Valve setting; *(100/255) to get in %
  1C         1  00          Valve Offset ; *(100/255) to get in %
  1D         ?  44 48 ...   Weekly program (see The weekly program)
  
  //for EQ3MAX_DEV_TYPE_WALLTHERMOSTAT
 x12   1    Comfort Temperature       in degrees celsius * 2
 x13   1    Eco Temperature           in degrees celsius * 2
 x14   1    Max Set Point Temperature in degrees celsius * 2
 x15   1    Min Set Point Temperature in degrees celsius * 2
 x1d   182  Weekly Program            Schedule of 26 bytes for
                                    each day starting with
                                    Saturday. Each schedule
                                    consists of 13 words
                                    (2 bytes) e.g. set points.
                                    1 set point consist of
                                    7 MSB bits is temperature
                                      set point (in degrees * 2)
                                    9 LSB bits is until time
                                      (in minutes * 5)
 xcc   3    Unknown
  */

  var payloadArr = payload.split(",");
  var rf_address = payloadArr[0].slice(0, 6).toString('hex');

  var decodedPayload = new Buffer(payloadArr[1], 'base64');
  //log(decodedPayload.toString('hex'));
  var length = decodedPayload[0];
  //log(length);
  var type = decodedPayload[4];
  var dataObj;

  switch(type) {
    case EQ3MAX_DEV_TYPE_THERMOSTAT:
    case EQ3MAX_DEV_TYPE_THERMOSTAT_PLUS:
      dataObj = {
        rf_address: decodedPayload.slice(1, 4).toString('hex'),
        device_type: decodedPayload[4],
        serial_number: String.fromCharCode.apply(null, decodedPayload.slice(8, 18)),
        comfort_temp: decodedPayload[18] / 2,
        eco_temp: decodedPayload[19] / 2,
        max_setpoint_temp: decodedPayload[20] / 2,
        min_setpoint_temp: decodedPayload[21] / 2,
        temp_offset: (decodedPayload[22] / 2) - 3.5,
        max_valve: decodedPayload[27] * (100/255)
      };
      break;
    case EQ3MAX_DEV_TYPE_WALLTHERMOSTAT:
      dataObj = {
        rf_address: decodedPayload.slice(1, 4).toString('hex'),
        device_type: decodedPayload[4],
        serial_number: String.fromCharCode.apply(null, decodedPayload.slice(8, 18)),
        comfort_temp: decodedPayload[18] / 2,
        eco_temp: decodedPayload[19] / 2,
        max_setpoint_temp: decodedPayload[20] / 2,
        min_setpoint_temp: decodedPayload[21] / 2
      };
      break;
    case EQ3MAX_DEV_TYPE_CUBE:
    case EQ3MAX_DEV_TYPE_SHUTTER_CONTACT:
      dataObj = {
        rf_address: decodedPayload.slice(1, 4).toString('hex'),
        device_type: decodedPayload[4],
        serial_number: String.fromCharCode.apply(null, decodedPayload.slice(8, 18))
      };
      break;
    default:
      break;
  }
  this.emit('configurationUpdate', dataObj);
}

function parseCommandDeviceList (payload) {
  var dataObj = [];
  var decodedPayload = new Buffer(payload, 'base64');

  while (decodedPayload.length > 0) {
    if (decodedPayload.length >= decodedPayload[0]) {
      var deviceStatus = decodeDevice.call(this, decodedPayload);

      // cache status
      this.devicesStatus[deviceStatus.rf_address] = deviceStatus;

      dataObj.push(deviceStatus);

      decodedPayload = decodedPayload.slice(decodedPayload[0] + 1);
    }
  };

  this.emit('statusUpdate', this.devicesStatus);

  return dataObj;
}

function parseCommandSendDevice (payload) {
  var payloadArr = payload.split(",");

  var dataObj = {
    accepted: payloadArr[1] == '1',
    duty_cycle: parseInt(payloadArr[0], 16),
    free_memory_slots: parseInt(payloadArr[2], 16)
  };

  return dataObj;
}

function setTemperature (rfAdress, mode, temperature, untilDate) {
  if (!this.isConnected) {
    log('Not connected');
    return;
  }

  log('Set temperature on ' + rfAdress + ' to ' + temperature + ' and mode ' + mode);

  var self = this;
  var callback = function (dataObj) {
    self.dutyCycle = dataObj.duty_cycle;
    self.memorySlots = dataObj.free_memory_slots;
    log('Duty cycle %: ' + this.dutyCycle + ', Free memory slots: ' + this.memorySlots);
  }

  var date_until = '0000';
  var time_until = '00';

  // 00 = Auto weekprog (no temp is needed, just make the whole byte 00)
  // 01 = Permanent
  // 10 = Temporarily
  var modeBin;
  switch (mode) {
    case 'AUTO':
    modeBin = '00';
    break;
    case 'MANUAL':
    modeBin = '01';
    break;
    case 'VACATION':
    modeBin = '10';
    var momentDate = moment(untilDate);
    var year_until = ('0000000' + (momentDate.get('year') - 2000).toString(2)).substr(-7);
    var month_until = ('0000' + (momentDate.get('month')).toString(2)).substr(-4);
    var day_until = ('00000' + momentDate.get('date').toString(2)).substr(-5);
    date_until = parseInt(('0000' + (month_until.substr(0,3) + day_until + month_until.substr(-1) + year_until)),2).toString(16).substr(-4);
    time_until = ('00' + Math.round((momentDate.get('hour') + (momentDate.get('minute') / 60)) * 2).toString(16)).substr(-2);
    break;
    case 'BOOST':
    modeBin = '11';
    break;
    default:
    log('Unknown mode: ' + mode);
    return false;
  }

  if (modeBin == '00') {
    var reqTempBinary = modeBin + padLeft(((temperature || 0) * 2).toString(2), 6);
    var reqTempHex = padLeft(parseInt(reqTempBinary, 2).toString(16), 2);
  } else {
    // leading zero padding
    var reqTempBinary = modeBin + ("000000" + (temperature * 2).toString(2)).substr(-6);
    // to hex string
    var reqTempHex = parseInt(reqTempBinary, 2).toString(16);
  }

  var room_id = "00";
  if (this.devices[rfAdress])
    room_id = ("00" + this.devices[rfAdress].room_id).substr(-2);

  var payload = new Buffer('000440000000' + rfAdress + room_id + reqTempHex + date_until + time_until, 'hex').toString('base64');
  var data = 's:' + payload + '\r\n';
  send.call(this, data, callback);

  log('Data sent: s:' + payload);
};

function doHeartbeat (callback) {
  var self = this;
  if (!this.isConnected) {
    this.client.connect(this.port, this.ip, function() {
      log('Connected');
      self.isConnected = true;
    });
  } else {
    send.call(self, 'l:\r\n', callback);
  }
}

function decodeDevice (payload) {
  var rf_address = payload.slice(1, 4).toString('hex');
  if (!this.devices[rf_address])
      return {data: payload.slice(4, 1+parseInt(payload.slice(0, 1).toString('hex'), 16)).toString('hex'), rf_address: rf_address};
  switch (this.devices[rf_address].devicetype) {
    case EQ3MAX_DEV_TYPE_THERMOSTAT:
      return decodeDeviceThermostat.call(this, payload);
      break;
    case EQ3MAX_DEV_TYPE_THERMOSTAT_PLUS:
      return decodeDeviceThermostat.call(this, payload);
      break;
    case  EQ3MAX_DEV_TYPE_SHUTTER_CONTACT:
      return deviceDeviceShutterContact.call(this, payload);
      break;
    case  EQ3MAX_DEV_TYPE_WALLTHERMOSTAT:
      return decodeDeviceWallThermostat.call(this, payload);
      break;
    default:
      log('Decoding device of type ' + this.devices[rf_address].devicetype + ' not yet implemented:' + payload.toString('hex'));
  }

  return {rf_address: rf_address};
}

function deviceDeviceShutterContact(payload){
  var data = ''
  data = padLeft(payload[6].toString(2), 8);
  var deviceStatus = {
    rf_address: payload.slice(1, 4).toString('hex'),
    state: parseInt(data.substr(6, 1)) ? 'open' : 'closed',
    battery_low: parseInt(data.substr(0, 1)) ? true : false
  }
  return deviceStatus;
}

function messageState(mesg, bits) {
/* byte 5 from http://www.domoticaforum.eu/viewtopic.php?f=66&t=6654
5          1  12          bit 4     Valid              0=invalid;1=information provided is valid
                          bit 3     Error              0=no; 1=Error occurred
                          bit 2     Answer             0=an answer to a command,1=not an answer to a command
                          bit 1     Status initialized 0=not initialized, 1=yes
                               
                          12  = 00010010b
                              = Valid, Initialized
*/
	mesg.initialized = !!(bits & (1 << 1));
	mesg.fromCmd = !!(bits & (1 << 2));
	mesg.error = !!(bits & (1 << 3));
	mesg.valid = !!(bits & (1 << 4));
}

function deviceState(dev, bits) {
/* byte 6 from http://www.domoticaforum.eu/viewtopic.php?f=66&t=6654
6       1     1A          bit 7     Battery       1=Low
                          bit 6     Linkstatus    0=OK,1=error
                          bit 5     Panel         0=unlocked,1=locked
                          bit 4     Gateway       0=unknown,1=known
                          bit 3     DST setting   0=inactive,1=active
                          bit 2     Not used
                          bit 1,0   Mode         00=auto/week schedule
                                                 01=Manual
                                                 10=Vacation
                                                 11=Boost   
                          1A  = 00011010b
                              = Battery OK, Linkstatus OK, Panel unlocked, Gateway known, DST active, Mode Vacation.

*/
	switch (bits & 0x3) {
		case EQ3MAX_DEV_MODE_AUTO: dev.mode = "AUTO"; break;
		case EQ3MAX_DEV_MODE_MANU: dev.mode = "MANUAL"; break;
		case EQ3MAX_DEV_MODE_VACATION: dev.mode = "VACATION"; break;
		case EQ3MAX_DEV_MODE_BOOST: dev.mode = "BOOST"; break;
	}
	dev.dst_active = !!(bits & (1 << 3));
	dev.gateway_known = !!(bits & (1 << 4));
	dev.panel_locked = !!(bits & (1 << 5));
	dev.link_error = !!(bits & (1 << 6));
	dev.battery_low = !!(bits & (1 << 7));
}

function decodeDeviceWallThermostat (payload) {
	var deviceStatus = {
		rf_address: payload.slice(1, 4).toString('hex'),
	};
	messageState(deviceStatus, payload[5]);
	deviceState(deviceStatus, payload[6]);
	deviceStatus.setpoint = ((payload[8] & 0x7F) / 2); //7 bit
    deviceStatus.temp = ((payload[8] & (1 << 7))?25.5:0) + payload[12] / 10; //if 8th bit = 1 then 25.5+
	return deviceStatus;
}

function decodeDeviceThermostat (payload) {
  /*
    source: http://www.domoticaforum.eu/viewtopic.php?f=66&t=6654
    Start Length  Value       Description
    ==================================================================
    0        1    0B          Length of data: 0B = 11(decimal) = 11 bytes
    1        3    003508      RF address
    4        1    00          ?
    5        1    12          bit 4     Valid              0=invalid;1=information provided is valid
                              bit 3     Error              0=no; 1=Error occurred
                              bit 2     Answer             0=an answer to a command,1=not an answer to a command
                              bit 1     Status initialized 0=not initialized, 1=yes

                              12  = 00010010b
                                  = Valid, Initialized

    6       1     1A          bit 7     Battery       1=Low
                              bit 6     Linkstatus    0=OK,1=error
                              bit 5     Panel         0=unlocked,1=locked
                              bit 4     Gateway       0=unknown,1=known
                              bit 3     DST setting   0=inactive,1=active
                              bit 2     Not used
                              bit 1,0   Mode         00=auto/week schedule
                                                     01=Manual
                                                     10=Vacation
                                                     11=Boost
                              1A  = 00011010b
                                  = Battery OK, Linkstatus OK, Panel unlocked, Gateway known, DST active, Mode Vacation.

    7       1     20          Valve position in %
    8       1     2C          Temperature setpoint, 2Ch = 44d; 44/2=22 deg. C
    9       2     858B        Date until (05-09-2011) (see Encoding/Decoding date/time)
    B       1     2E          Time until (23:00) (see Encoding/Decoding date/time)
    */

    var mode = 'AUTO';
    if ((payload[6] & 3) === 3) {
      mode = 'BOOST';
    } else if (payload[6] & (1 << 0)) {
      mode = 'MANUAL';
    } else if (payload[6] & (1 << 1)) {
      mode = 'VACATION';
    }

    var deviceStatus = {
      rf_address: payload.slice(1, 4).toString('hex'),
      initialized: !!(payload[5] & (1 << 1)),
      fromCmd: !!(payload[5] & (1 << 2)),
      error: !!(payload[5] & (1 << 3)),
      valid: !!(payload[5] & (1 << 4)),
      mode: mode,
      dst_active: !!(payload[6] & (1 << 3)),
      gateway_known: !!(payload[6] & (1 << 4)),
      panel_locked: !!(payload[6] & (1 << 5)),
      link_error: !!(payload[6] & (1 << 6)),
      battery_low: !!(payload[6] & (1 << 7)),
      valve: payload[7],
      setpoint: (payload[8] / 2)
    };

    if (mode === 'VACATION') {
    // from http://sourceforge.net/p/fhem/code/HEAD/tree/trunk/fhem/FHEM/10_MAX.pm#l573
      deviceStatus.date_until = 2000 + (payload[10] & 0x3F) + "-" + padLeft(((payload[9] & 0xE0) >> 4) | (payload[10] >> 7), 2) + "-" + padLeft(payload[9] & 0x1F, 2);
      var hours = (payload[11] & 0x3F) / 2;
      deviceStatus.time_until = ('00' + Math.floor(hours)).substr(-2) + ':' + ((hours % 1) ? "30" : "00");
    } else {
      deviceStatus.temp = (payload[9]?25.5:0) + payload[10] / 10;
    }

    // set user setpoint
    if (!this.devicesStatus[deviceStatus.rf_address] || !this.devicesStatus[deviceStatus.rf_address].setpoint_user || Math.abs(this.devicesStatus[deviceStatus.rf_address].setpoint_user - deviceStatus.setpoint) >= 1) {
      deviceStatus.setpoint_user = deviceStatus.setpoint;
      log('new user setpoint for device ' + deviceStatus.rf_address + ' is ' + deviceStatus.setpoint);
    } else {
      // copy old value
      deviceStatus.setpoint_user = this.devicesStatus[deviceStatus.rf_address].setpoint_user;
    }

    // overwrite lastUpdate-timestamp only when temperature received
    if (deviceStatus.temp !== undefined && deviceStatus.temp !== 0) {
      deviceStatus.lastUpdate = moment().format();
    } else if (this.devicesStatus[deviceStatus.rf_address]) {
      deviceStatus.lastUpdate = this.devicesStatus[deviceStatus.rf_address].lastUpdate;
      deviceStatus.temp = this.devicesStatus[deviceStatus.rf_address].temp;
    }

    return deviceStatus;
}

MaxCube.prototype.log = function(message) {
  fs.appendFile('log_maxcube.txt', '[' + moment().format() + '] ' + message + "\n");
}
function log (message) {
  MaxCube.log(message);
}

module.exports = MaxCube;
