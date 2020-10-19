<<<<<<< HEAD
const  socket = io('/')

socket.emit('join-room',RoomID,10)
=======
const socket = io('/')


socket.emit('join-room',room_Id, 10)

socket.on('user-connected',userId=>{
console.log("User Id:"+userId)

})
>>>>>>> 3b6e77272bb31607402b1af91ab37f9c60417d29
