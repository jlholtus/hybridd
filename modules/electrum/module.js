// (C) 2015 Internet of Coins / Metasync / Joachim de Koning
// hybridd module - electrum/module.js
// Module to connect to Electrum or any of its derivatives

// required libraries in this context
var fs = require('fs');
var Client = require('../../lib/rest').Client;

// exports
exports.init = init;
exports.tick = tick;
exports.exec = exec;
exports.stop = stop;
exports.link = link;
exports.post = post;

// initialization function
function init() {
  modules.initexec('electrum',['init']);
}

// stop function
function stop() {
}

// scheduled ticker function
function tick(properties) {
}

// standard functions of an asset store results in a process superglobal -> global.hybridd.process[processID]
// child processes are waited on, and the parent process is then updated by the postprocess() function
// http://docs.electrum.org/en/latest/protocol.html
function exec(properties) {
	// decode our serialized properties
	var processID = properties.processID;
	var target = properties.target;
	var mode  = target.mode;
	var factor = (typeof target.factor != 'undefined'?target.factor:null);
  var fee = (typeof target.fee != 'undefined'?target.fee:null);
	var subprocesses = [];	
	// set request to what command we are performing
	global.hybridd.proc[processID].request = properties.command;
  // define the source address/wallet
  var sourceaddr = (typeof properties.command[1] != 'undefined'?properties.command[1]:false);
	// handle standard cases here, and construct the sequential process list
	switch(properties.command[0]) {
		case 'init':
      // set up REST API connection
      if(typeof target.user != 'undefined' && typeof target.pass != 'undefined') {
        var options_auth={user:target.user,password:target.pass};
        global.hybridd.asset[target.symbol].link = new Client(options_auth);
      } else { global.hybridd.asset[target.symbol].link = new Client(); }    
			// set up init probe command to check if RPC and block explorer are responding and connected
			subprocesses.push('func("electrum","link",{target:'+jstr(target)+',command:["version"]})');
      // TODO: check block explorer here too!
      subprocesses.push('pass( (data != null && typeof data.result=="string" && data.result.indexOf(".")>-1 ? 1 : 0) )');      
      subprocesses.push('logs(1,"module electrum: "+(data?"connected":"failed connection")+" to ['+target.symbol+'] host '+target.host+'")');      
		break;
		case 'status':
			// set up init probe command to check if Altcoin RPC is responding and connected
			subprocesses.push('func("electrum","link",{target:'+jstr(target)+',command:["version"]})');
			subprocesses.push('func("electrum","post",{target:'+jstr(target)+',command:["status"],data:data})');
		break;
		case 'factor':
      // directly return factor, post-processing not required!
      subprocesses.push('stop(0,"'+factor+'")');
		break;
		case 'fee':
      // directly return fee, post-processing not required!
      subprocesses.push('stop(0,"'+padFloat(fee,factor)+'")');
		break;
		case 'balance':
      if(sourceaddr) {
        subprocesses.push('func("electrum","link",{target:'+jstr(target)+',command:["getaddressbalance",["'+sourceaddr+'"]]})'); // send balance query
        subprocesses.push('stop((data!=null && typeof data.result!="undefined" && typeof data.result.confirmed!="undefined"?0:1),(data!=null && typeof data.result!="undefined" && typeof data.result.confirmed!="undefined"?fromInt(toInt(data.result.confirmed,'+factor+').plus(toInt(data.result.unconfirmed,'+factor+')),'+factor+'):null))');
      } else {
        subprocesses.push('stop(1,"Error: missing address!")');
      }
		break;
		case 'push':
      var deterministic_script = (typeof properties.command[1] != 'undefined'?properties.command[1]:false);
      if(deterministic_script) {
        subprocesses.push('func("electrum","link",{target:'+jstr(target)+',command:["broadcast",["'+deterministic_script+'"]]})');
        // example: {"jsonrpc":"2.0","result":[true,"b4a8d3939e9ee75221e5453d52b27763f3de51b0ffa7670e68b7f8d420f88e49"],"id":0}
        subprocesses.push('stop((typeof data.result[0]!="undefined" && data.result[0]===true && data.result[1]!="undefined"?0:1),(typeof data.result[1]!="undefined"?data.result[1]:null))');
      } else {
        subprocesses.push('stop(1,"Missing or badly formed deterministic transaction!")');
      }
    break;
		case 'unspent':
      if(sourceaddr) {
        subprocesses.push('func("blockexplorer","exec",{target:'+jstr( modules.getsource(mode) )+',command:["unspent","'+sourceaddr+'"'+(properties.command[2]?',"'+properties.command[2]+'"':'')+']})');
      } else {
        subprocesses.push('stop(1,"Error: missing address!")');
      }
    break;
		case 'history':
		break;
		default:
		 	subprocesses.push('stop(1,"Asset function not supported!")');
	}
  // fire the Qrtz-language program into the subprocess queue
  scheduler.fire(processID,subprocesses);  
}

// standard function for postprocessing the data of a sequential set of instructions
function post(properties) {
	// decode our serialized properties
	var processID = properties.processID
	var target = properties.target
	var postdata = properties.data;
	// set data to what command we are performing
	global.hybridd.proc[processID].data = properties.command;
	// handle the command
	if (postdata == null) {
		var success = false;
	} else {
		var success = true;
		switch(properties.command[0]) {
			case 'status':
        // nicely cherrypick and reformat status data
        var collage = {};
        collage.module = 'electrum';
        collage.synced = null;
        collage.blocks = null;
        collage.fee = null;
        collage.supply = null;
        collage.difficulty = null;
        collage.testmode = null;
        collage.version = (typeof postdata.result=='string' ? postdata.result : null);
        postdata = collage;
			break;
			default:
				success = false;		
		}
	}
  // stop and send data to parent
  scheduler.stop(processID,{err:(success?0:1),data:postdata});
}

// data returned by this connector is stored in a process superglobal -> global.hybridd.process[processID]
function link(properties) {
	var target = properties.target;
  var base = target.symbol.split('.')[0];     // in case of token fallback to base asset  
	var processID = properties.processID;
	var command = properties.command;
	if(DEBUG) { console.log(' [D] module electrum: sending REST call for ['+target.symbol+'] -> '+jstr(command)); }
  // separate method and arguments
	var method = command.shift();
	var params = command.shift();
	// validate the JSON data with a regex after the REST method path
	var args = {
		headers:{"Content-Type": "application/json"},
    data: {
        "method": method,
        "params": params,
        "jsonrpc": "2.0",
        "id": 0
      }
	}
  // construct the APIqueue object
  APIqueue.add({ 'method':'POST',
                 'link':'asset["'+base+'"]',  // make sure APIqueue can use initialized API link
                 'host':(typeof target.host!=='undefined'?target.host:global.hybridd.asset[base].host),  // in case of token fallback to base asset hostname
                 'args':args,
                 'throttle':(typeof target.throttle!=='undefined'?target.throttle:global.hybridd.asset[base].throttle),  // in case of token fallback to base asset throttle
                 'pid':processID,
                 'target':target.symbol });
}    

