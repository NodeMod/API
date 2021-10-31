const Gateway = require('./gateway/gateway-connection');
const socket = Gateway("token here");

socket.connect();

socket.on('MESSAGE_CREATE', (shard, data) => {
  console.log(shard, data);
});

socket.on('DEBUG', (shard, data) => {
    console.log(shard, data);
});