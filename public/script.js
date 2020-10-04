const socket = io('/')


socket.emit('join-room',room_Id, 10)

socket.on('user-connected',userId=>{
console.log("User Id:"+userId)

})