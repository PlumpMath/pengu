"use strict";
function getParameterByName(name) {
	name = name.replace(/[\[]/, "\\\[").replace(/[\]]/, "\\\]");
	var regexS = "[\\?&]" + name + "=([^&#]*)";
	var regex = new RegExp(regexS);
	var results = regex.exec(window.location.search);
	if(results == null) {
		return "";
	} else {
		return decodeURIComponent(results[1].replace(/\+/g, " "));
	}
}

Object.prototype.removeItem = function (key) {
	if(!this.hasOwnProperty(key)){
		return;
	}
	if(isNaN(parseInt(key)) || !(this instanceof Array)) {
		delete this[key];
	} else {
		this.splice(key, 1);
	}
};

$(function () {
	var view = $('#view');
	var myName = null;
	var myRoom = 'plaza';
	var speed = 150; // px per sec
	var players = {};
	var msgTimeouts = {};

	window.WebSocket = window.WebSocket || window.MozWebSocket;

	if(!window.WebSocket) {
		name.html('Smůla, tvůj prohlížeč nepodporuje WebSockets.');
		return;
	}

	var connection = new WebSocket('ws://'+window.location.hostname + (window.location.port == '' ? '' : ':' + window.location.port));

	connection.onopen = function () {
		connection.send(JSON.stringify({type: 'init', name: getParameterByName('u')}));
	};

	connection.onerror = function (error) {
		view.html('<p>Promiň, nefunguje server nebo tvé připojení.</p>');
	};

	// most important part - incoming messages
	connection.onmessage = function (message) {
		// try to parse JSON message. Because we know that the server always returns
		// JSON this should work without any problem but we should make sure that
		// the massage is not chunked or otherwise damaged.
		try {
			var json = JSON.parse(message.data);
		} catch(e) {
			console.log('This doesn\'t look like a valid JSON: ', message.data);
			return;
		}
		if(json.type === 'sync') {
			myName = json.name;
			for(var key in json.data) {
				if(json.data.hasOwnProperty(key)){
					addPlayer(key, json.data[key][2]);
					movePlayer(key, json.data[key][0], json.data[key][1]);
				}
			}
		} else if(json.type === 'enter') {
			addPlayer(json.name, json.room, json.x, json.y);
		} else if(json.type === 'exit') {
			removePlayer(json.name);
		} else if(json.type === 'move') {
			if(json.travel) {
				movePlayer(json.name, json.x, json.y, json.travel, json.newX, json.newY);
				players[json.name].attr('data-room', json.room);
			} else {
				movePlayer(json.name, json.x, json.y);
			}
		} else if(json.type === 'say') {
			speakForPlayer(json.name, json.text);
		} else {
			console.log('Hmm..., I\'ve never seen JSON like this: ', json);
		}
	};

	view.click(function(e) {
		connection.send(JSON.stringify({type: 'move', x: e.pageX - $(this).offset().left, y: e.pageY - $(this).offset().top}));
	});

	$('#message').keydown(function(e) {
		if(e.keyCode == 13){
			connection.send(JSON.stringify({type: 'message', text: $(this).val()}));
			$(this).val('');
		}
	});

	var monitor = setInterval(function() {
		if(connection.readyState !== 1) {
			clearInterval(monitor);
			alert('Nelze komunikovat s WebSocket serverem.');
		}
	}, 3000);

	function addPlayer(name, room, x, y) {
		players[name] = $('<div data-name="'+name+'" data-room="'+room+'" class="penguin"><div class="message"><p>I am a penguin eating zebra filled with bubblegum</p></div></div>');
		if(typeof x !== 'undefined') {
			players[myName].css({top: y, left: x});
		}
		if(room == myRoom) {
			showPlayer(name);
		}
	}
	function showPlayer(name) {
		view.append(players[name]);
	}
	function movePlayer(name, x, y, room, newX, newY) {
		// if(16 <= x && x <= view.width() - 16 && 16 <= y && y <= view.height() - 16)
		var left = players[name].css('left').slice(0, -2);
		var top = players[name].css('top').slice(0, -2);
		var distance = Math.sqrt(Math.pow(left - x, 2) + Math.pow(top - y, 2));
		console.log(room);

		var handler = function() {}
		var travel = false;
		if(typeof room !== 'undefined') {
			handler = function() {
				if(room == myRoom) {
					showPlayer(name);
				} else {
					if(name == myName) {
						view.css('background-image', 'url(' + room + '.png)');
						myRoom = room;
						travel = true;
						players[myName].attr('data-room', myRoom);
						players[myName].css({top: newY, left: newX});
						for(var key in players) {
							if(players.hasOwnProperty(key)){
								if(players[key].attr('data-room') == myRoom) {
									showPlayer(key);
								} else {
									hidePlayer(key);
								}
							}
						}
					} else {
						hidePlayer(name);
					}
				}
			}
		}
		players[name].animate({top: y, left: x}, distance / speed * 1000, 'linear', handler);
	}
	function removePlayer(name) {
		players[name].remove();
		hidePlayer(name);
	}
	function hidePlayer(name) {
		players[name].remove();
	}
	function speakForPlayer(name, message) {
		if(msgTimeouts[name]) {
			clearTimeout(msgTimeouts[name]);
		}
		msgTimeouts[name] = setTimeout(function() {
			players[name].find('.message').hide();
		}, 5000);
		players[name].find('.message').show().find('p').text(message);
	}
});