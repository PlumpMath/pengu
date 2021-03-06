#!/usr/bin/env node
'use strict';

process.title = 'pengu';
let _dbUri = process.env.DATABASE_URL;

let WebSocketServer = require('websocket').server;
let http = require('http');
let path = require('path');
let express = require('express');
let pg = require('pg');
let poly = require('./poly');
let Point = poly.Point;
let Line = poly.Line;
let pengu = require('./pengu');


Object.prototype.removeItem = function(key) {
	if (!this.hasOwnProperty(key)){
		return;
	}
	if (isNaN(parseInt(key)) || !(this instanceof Array)) {
		delete this[key];
	} else {
		this.splice(key, 1);
	}
};

Array.prototype.getByKey = function(key, value) {
	let cur;
	for (let i = 0, length = this.length; i < length; i++) {
		if (i in this) {
			cur = this[i];
			if (cur[key] === value) {
				return cur;
			}
		}
	}
};

Array.prototype.pushArray = function(arr) {
	this.push.apply(this, arr);
};

let app = express();

app.set('port', process.env.PORT || 8080);
let serveStatic = require('serve-static');
app.use('/content', serveStatic(path.join(__dirname, 'content')));
app.use('/client', serveStatic(path.join(__dirname, 'client')));

let session = require('express-session');
let signedCookie = require('cookie-parser').signedCookie;
let sessionStore = new session.MemoryStore();
let secret = Math.random().toString();
app.use(session({store: sessionStore, resave: true, saveUninitialized: true, secret: secret, cookie: { maxAge: 10000 }, key: 'sid'}));

let env = process.env.NODE_ENV || 'development';
if (env === 'development') {
	app.use(require('morgan')('combined'));
}


app.get('/', function(req, res) {
	if (!req.session.user) {
		res.redirect('/authenticate');
	} else {
		res.statusCode = 200;
		res.sendFile(path.join(__dirname, 'client.html'));
	}
});

if (process.env.OPENID_PROVIDER) {
	require('./auth/openid')(app, process.env.OPENID_VERIFY, process.env.OPENID_REALM, process.env.OPENID_PROVIDER);
} else {
	require('./auth/simple')(app);
}

let server = http.createServer(app).listen(app.get('port'));
console.log('Started app on port %d', app.get('port'));

let wsServer = new WebSocketServer({
	httpServer: server,
	port: 1337,
	autoAcceptConnections: false
});

function originIsAllowed(origin) {
	return true;
}

// function isInRect(door, x, y) {
// 	return x >= door[0][0] && x <= door[1][0] && y >= door[0][1] && y <= door[1][1];
// }

function getTarget(room, line) {
	let gap = 5;
	let intersections = [];
	for (let i = room.zones.length - 1; i >= 0; i--) {
		let zone = room.zones[i];
		if (zone.type[0] === 'floor' || zone.type[0] === 'obstacle') {
			intersections.pushArray(zone.area.getIntersections(line));
		}
	}
	let target;
	if (intersections.length > 0){
		let targetDistance = Infinity;
		for (let i = intersections.length - 1; i >= 0; i--) {
			let intersection = intersections[i];
			let distance = Math.abs(line.start.x - intersection.x);
			if (targetDistance > distance) {
				targetDistance = distance;
				target = intersection;
			}
		}

		target.x += gap / line.getLength() * (line.start.x - line.end.x);
		target.y += gap / line.getLength() * (line.start.y - line.end.y);
	} else {
		target = line.end;
	}

	target.x = Math.round(target.x);
	target.y = Math.round(target.y);
	return target;
}

let clients = [];
let players = {};
let rooms = JSON.parse(require('fs').readFileSync(path.join(__dirname, 'content/world/map.json'), 'utf8'), function (key, value) {
	let type;
	if (value && typeof value === 'object') {
		type = value._class;
		if (typeof type === 'string' && typeof poly[type] === 'function') {
			return new (poly[type])(value);
		}
	}
	return value;
});
let items = JSON.parse(require('fs').readFileSync(path.join(__dirname, '/content/items/items.json'), 'utf8'));

let dbEnabled = true;
var pgpool = new pg.Pool({connectionString: _dbUri});
pgpool.connect(function connectToDb(err, pgclient, pgdone) {
	if (err) {
		pgdone();
		console.error('Couldn\'t connect to database, data aren\'t persitent', err);
		dbEnabled = false;
	}
	let registered = {};
	if (dbEnabled) {
		pgclient.query('select * from "penguin"', getPenguinsFromDb);
	} else {
		getPenguinsFromDb(null, null);
	}
	function getPenguinsFromDb(err, result) {
		if (!err) {
			if (result) {
				for (let i = 0; i < result.rows.length; i++) {
					registered[result.rows[i].name] = result.rows[i];
				}
			}
		} else {
			console.error('Couldn\'nt read penguins from db', err);
			dbEnabled = false;
		}

		wsServer.on('request', function(request) {
			if (!originIsAllowed(request.origin)) {
				request.reject();
				console.log((new Date()) + ' Connection from origin ' + request.origin + ' rejected.');
				return;
			}

			let connection = request.accept(null, request.origin);
			clients.push(connection);
			console.log((new Date()) + ' Connection accepted.');
			connection.on('message', function(message) {
				if (message.type === 'utf8') {
					try {
						let json = JSON.parse(message.utf8Data);
						console.log(json);
						if (json.type === 'init' && connection.name === undefined) {
							let sid = signedCookie(request.cookies.filter((x) => x.name == 'sid')[0].value, secret);
							sessionStore.get(sid, function(err, session) {
							if (err || !session) {
								connection.drop(pengu.SESSION_READ_ERROR, 'Problems reading session');
								if (err) {
									throw err;
								}
								return;
							}
							if (players.hasOwnProperty(session.user)) {
								connection.drop(pengu.USERNAME_ALREADY_BEING_USED, 'Username already being used');
								return;
							}
							let name = connection.name = session.user;
							connection.sendUTF(JSON.stringify({type: 'sync', name: name, data: players}));
							if (!registered.hasOwnProperty(name)) {
								registered[name] = {clothing: [], closet: {}, registered: (new Date()).toUTCString(), group: json.group};
								if (dbEnabled) {
									pgclient.query('insert into "penguin"("name", "closet", "clothing", "registered", "group") VALUES($1, $2, $3, $4, $5)', [name, JSON.stringify(registered[name].closet), JSON.stringify(registered[name].clothing), registered[name].registered, registered[name].group], function insertPenguinToDb(err) {
										if (err) {
											console.log(err);
										}
									});
								}
							}
							players[name] = registered[name];
							players[name].x = 550;
							players[name].y = 500;
							players[name].room = 'plaza';

							console.info('Initial handshake with ' + name);
							for (let i = 0; i < clients.length; i++) {
								clients[i].sendUTF(JSON.stringify({type: 'enter', name: name, room: players[name].room, x: players[name].x, y: players[name].y, clothing: players[name].clothing}));
							}
							connection.sendUTF(JSON.stringify({type: 'syncCloset', closet: players[name].closet}));
							});
						} else if (json.type === 'move') {
							let travel = false;
							let name = connection.name;
							let room = players[name].room;
							let target = getTarget(rooms[room], new Line(new Point(players[name].x, players[name].y), new Point(json.x, json.y)));
							if (rooms[room].zones[0].area.containsPoint(target)) {
								console.log('Moving ' + name + ' to ' + target);
								players[name].x = target.x;
								players[name].y = target.y;
								players[name].room = players[name].room;
								for (let i = 0; i < rooms[room].zones.length; i++) {
									let zone = rooms[room].zones[i];
									if (zone.type[0] === 'door' && zone.area.containsPoint(target)) {
										room = travel = zone.type[1];
										console.log(name + ' goes to ' + travel);
										players[name].room = travel;
										break;
									}
								}
								let msg = {type: 'move', name: name, x: players[name].x, y: players[name].y};
								if (travel) {
									msg.travel = travel;
									players[name].x = msg.newX = rooms[travel].spawn.x;
									players[name].y = msg.newY = rooms[travel].spawn.y;
								}
								for (let i = 0; i < clients.length; i++) {
									clients[i].sendUTF(JSON.stringify(msg));
								}
							}
						} else if (json.type === 'message') {
							json.text = json.text.trim();
							if (json.text !== '') {
								let name = connection.name;
								if (json.text.indexOf('/') === 0) {
									if (json.text.indexOf('/mute ') === 0 && ['admin', 'moderator'].indexOf(players[name].group) > -1) {
										let bannedName = json.text.substr(6);
										players[bannedName].banned = true;
										if (dbEnabled) {
											pgclient.query('update "penguin" set "banned"=true where "name"=$1', [bannedName], function mutePenguin(err) {
												if (err) {
													console.log(err);
												}
											});
										}
									} else if (json.text.indexOf('/unmute ') === 0 && ['admin', 'moderator'].indexOf(players[name].group) > -1) {
										let bannedName = json.text.substr(8);
										players[bannedName].banned = false;
										if (dbEnabled) {
											pgclient.query('update "penguin" set "banned"=false where "name"=$1', [bannedName], function mutePenguin(err) {
												if (err) {
													console.log(err);
												}
											});
										}
									}
								} else {
									if (!players[name].banned) {
										console.log(name + ' said ' + json.text);
										for (let i = 0; i < clients.length; i++) {
											clients[i].sendUTF(JSON.stringify({type: 'say', name: name, text: json.text}));
										}
									} else {
										connection.sendUTF(JSON.stringify({type: 'say', name: name, text: json.text}));
									}
								}
							}
						} else if (json.type === 'addItem') {
							let name = connection.name;
							json.itemId = parseInt(json.itemId);
							if (!items.getByKey('id', json.itemId).available) {
								connection.sendUTF(JSON.stringify({type: 'error', message: 'Tato věc nejde v současnosti získat.'}));
								console.log(name + ' attempted to acquire ' + json.itemId);
							} else if (!players[name].closet.hasOwnProperty(json.itemId)) {
								players[name].closet[json.itemId] = {'date': new Date(), 'means': 'collect'};
								if (dbEnabled) {
									pgclient.query('update "penguin" set "closet"=$2 where "name"=$1', [name, JSON.stringify(players[name].closet)], function insertPenguinToDb(err) {
										if (err) {
											console.log(err);
										}
									});
								}
								connection.sendUTF(JSON.stringify({type: 'syncCloset', closet: players[name].closet}));
								console.log(name + ' acquired ' + json.itemId);
							} else {
								connection.sendUTF(JSON.stringify({type: 'error', message: 'Tuto věc již máš.'}));
								console.log(name + ' attempted to reacquire ' + json.itemId);
							}
						} else if (json.type === 'dress') {
							let name = connection.name;
							json.itemId = parseInt(json.itemId);
							if (players[name].closet.hasOwnProperty(json.itemId)) {
								if (players[name].clothing.indexOf(json.itemId) > -1) {
									players[name].clothing.splice(players[name].clothing.indexOf(json.itemId), 1);
									console.log(name + ' undressed ' + json.itemId);
								} else {
									players[name].clothing.push(json.itemId);
									console.log(name + ' dressed ' + json.itemId);
								}
								if (dbEnabled) {
									pgclient.query('update "penguin" set "clothing"=$2 where "name"=$1', [name, JSON.stringify(players[name].clothing)], function insertPenguinToDb(err) {
										if (err) {
											console.log(err);
										}
									});
								}
								for (let i = 0; i < clients.length; i++) {
									clients[i].sendUTF(JSON.stringify({type: 'dress', name: name, clothing: players[name].clothing}));
								}
							}
						}
					} catch (ex) {
						console.error(ex);
					}
					// connection.sendUTF(message.utf8Data);
				}
			});
			connection.on('close', function(reasonCode, description) {
				let index = clients.indexOf(connection);
				if (index !== -1) {
					// remove the connection from the pool
					clients.splice(index, 1);
				}
				registered[connection.name] = players[connection.name];
				players.removeItem(connection.name);
				console.log((new Date()) + ' Peer ' + connection.remoteAddress + '(' + connection.name + ') disconnected.' + (description ? ' Reason: ' + description : ''));
				for (let i = 0; i < clients.length; i++) {
					clients[i].sendUTF(JSON.stringify({type: 'exit', name: connection.name}));
				}
			});
		});
	}
});

function exitHandler(options) {
	console.log('Server is going down')
	for (let client of clients) {
		client.drop(pengu.SERVER_GOING_DOWN, 'Server is going down');
	}
	process.exit();
}

process.on('SIGINT', exitHandler);
