// Require modules
const WebSocket = require('ws');
const EventEmitter = require('events');

/** 
 * @description Function for parse JSON data, used for make the work more faster
**/
let p = (func) => {
	return (data) => {
		func(JSON.parse(data));
	}
}
// This variable is used for call .stringify function more faster
let e = JSON.stringify;
// Encoding mode
let encoding = 'json';
// If erlpack library is installed, used it for decode JSON data more faster
try {
	const erlpack = require('erlpack');
	p = (func) => {
		return (data) => {
			func(erlpack.unpack(data));
		}
	}
	e = erlpack.pack;
	encoding = 'etf';
} catch (e) {
    if(e) return;
}

/** 
 * @description Main class for connection and actions to the Discord Api
**/
class Connection {
	constructor(main, shard) {
		this.socket = null;
		this.hbinterval = null;
		this.hbfunc = null;
		this.hbtimer = null;
		this.s = -1;
		this.session = -1;
		this.shard = shard;
		this.main = main;
	}

    /** 
     * @description Function that is called and send an event when client receive 11 opcode
     * @see https://discord.com/developers/docs/topics/gateway#heartbeating
    **/
	acknowledge() {
		this.main.emit('DEBUG', this.shard, 'Sent in response to receiving a heartbeat to acknowledge that it has been received.');
		this.hbfunc = this.beat;
	}

    /** 
     * @description Function for periodically send heartbeat
     * @see https://discord.com/developers/docs/topics/gateway#heartbeating
    **/
	beat() {
		this.main.emit('DEBUG', this.shard, 'Fired periodically by the client to keep the connection alive.');
		this.socket.send(e({
			op: 1,
			d: this.s
		}));
		this.hbfunc = this.resume;
	}

    /** 
     * @description Function that is called when server send a 7 reconnect opcode
     * @see https://discord.com/developers/docs/topics/gateway#resuming
    **/
	resume() {
		this.main.emit('DEBUG', this.shard, 'Resume a previous session that was disconnected.');
		this.close().then(() =>
			this.connect()
		).then(() => {
			this.main.emit('DEBUG', this.shard, 'Sent resume packet');
			this.socket.send(e({
				op: 6,
				d: {
					token: this.main.token,
					session_id: this.session,
					seq: this.s
				}
			}));
		});
	}

    /** 
     * @description Function for close websocket connection
    **/
	close() {
		this.main.emit('DEBUG', this.shard, 'Client attempting to close connection');
		if (this.hbtimer) {
			clearInterval(this.hbtimer);
		}
		return new Promise((resolve, reject) => {
			if (this.socket.readyState !== 3) {
				this.socket.close(1001, 'Closed connection');
				this.socket.removeAllListeners('close');
				this.socket.once('close', () => {
					this.main.emit('DEBUG', this.shard, 'Client closed connection');
					resolve();
				});
			} else {
				resolve();
			}
		});
	}

    /** 
     * @description Function that is called for connect to Discord Api
     * @see https://discord.com/developers/docs/topics/gateway#connecting-to-the-gateway
    **/
	connect(cb) {
		this.main.emit('DEBUG', this.shard, 'starting connection packet');
		return new Promise((resolve, reject) => {
			this.socket = new WebSocket(this.main.url + '?encoding=' + encoding);
			this.socket.once('open', () => {
				this.main.emit('DEBUG', this.shard, 'opened connection');
				this.socket.once('message', p((payload) => {
					this.main.emit('DEBUG', this.shard, 'recieved heartbeat info ' + JSON.stringify(payload.d));
					this.hbinterval = payload.d.heartbeat_interval;
					this.hbfunc = this.beat;
					if (this.hbtimer) {
						clearInterval(this.hbtimer);
					}
					this.hbtimer = setInterval(() => this.hbfunc(), this.hbinterval);
					if (!cb) {
						setTimeout(() => resolve(this.identify()), 5000 - Date.now() + this.main.lastReady);
					} else {
						resolve(cb());
					}
				}));
			});
			this.socket.once('close', (code, reason) => {
				this.main.emit('DEBUG', this.shard, 'server closed connection. code: ' + code + ', reason: ' + reason + ' reconnecting in 10');
				setTimeout(() => this.close().then(() => this.connect()), 10000);
			});
			this.socket.once('error', () => {
				this.main.emit('DEBUG', this.shard, 'recieved error ' + e.message + ', reconnecting in 5');
				setTimeout(() => this.close().then(() => this.connect()), 5000);
			});
		});
	}

    /** 
     * @description Function that is called for send data to Discord Api
    **/
	send(data) {
		this.socket.send(e(data));
	}

    /** 
     * @description Function that is called for send identify opcode to the client
     * @see https://discord.com/developers/docs/topics/gateway#connecting-to-the-gateway
    **/
	identify() {
		return new Promise((resolve, reject) => {
			this.main.emit('DEBUG', this.shard, 'sent identify packet');
			this.socket.send(e({
				op: 2,
				d: {
					token: this.main.token,
					properties: {},
					shard: [this.shard, this.main.shards],
					compress: false,
					large_threshold: 250,
					presence: {}
				}
			}));
			this.socket.on('message', p((payload) => {
				this.s = payload.s;
				this.main.emit('PAYLOAD', this.shard, payload);
				if (payload.op === 11) {
					this.acknowledge();
				} else if (payload.t === 'RESUMED') {
					this.main.emit('DEBUG', this.shard, 'successfully resumed');
				} else if (payload.op === 0) {
					this.main.emit(payload.t, this.shard, payload.d);
				}
			}));
			this.socket.once('message', p((payload) => {
				if (payload.t === 'READY') {
					this.session = payload.d.session_id;
					this.main.emit('DEBUG', this.shard, 'is ready');
					resolve({ timeReady: Date.now(), socket: this });
				} else if (payload.op === 9) {
					this.main.emit('DEBUG', this.shard, 'invalid session, reconnecting in 5');
					setTimeout(() => this.close().then(() => this.connect()), 5000);
				}
			}));
		});
	}
}

/** 
 * @description Class that exends EventEmitter class for add some utility functions
**/
class GatewaySocket extends EventEmitter {
	constructor(token, shards = 'auto') {
		super();
		this.token = token;
		this.shards = shards;
		this.sockets = new Map();
		this.lastReady = 0;
	}

    /** 
     * @description Function for get gateway info
    **/
	getGatewayInfo() {
		return new Promise((resolve, reject) => {
			require('https').get({
				hostname: 'discordapp.com',
				path: '/api/gateway/bot',
				headers: {
					Authorization: "Bot " + this.token
				}
			}, (res) => {
				let data = '';
				res.on('data', (d) => {
					data += d;
				});
				res.on('end', () => {
					resolve(JSON.parse(data));
				});
			}).on('error', reject);
		});
	}

    /** 
     * @description Function for connect to Discord Api using sharding
     * @see https://discord.com/developers/docs/topics/gateway#sharding
    **/
	async connect(start = 0, end) {
		const { url, shards } = await this.getGatewayInfo();
		this.url = url;
		if (isNaN(this.shards)) {
			this.shards = shards;
		}
		end = end || this.shards;
		for (let i = start; i < end; i++) {
			if (this.sockets.get(i)) {
				await this.sockets.get(i).close();
			}
			this.sockets.set(i, new Connection(this, i));
			this.lastReady = (await this.sockets.get(i).connect()).timeReady;
		}
	}

    /** 
     * @description Function for send shards data to Discord Api
     * @see https://discord.com/developers/docs/topics/gateway#sharding
    **/
	send(data, shard = 0) {
		this.sockets.get(shard).send(data);
	}
}

/** 
 * @description Function for create GatewaySocket and effectly connect to the Discord Api
**/
function connectToGateway(token, shards) {
	return new GatewaySocket(token, shards);
}

module.exports = connectToGateway;