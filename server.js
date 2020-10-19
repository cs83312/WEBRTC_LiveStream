console.log("Starting RTC...")

const express = require("express")
const app = express()
const server = require('http').Server(app)
<<<<<<< HEAD
const io = require('socket.io')(server)
=======
const  io  = require('socket.io')(server)
>>>>>>> 3b6e77272bb31607402b1af91ab37f9c60417d29
const { v4: uuidV4 } = require('uuid')

app.set('view engine','ejs')
app.use(express.static('public'))

app.get('/',(req,res) => {
    res.redirect(`/${uuidV4()}`)
    
    })

app.get('/:room',(req,res)=> {
res.render('room',{roomId: req.params.room})
})

<<<<<<< HEAD
io.on('connection',socket =>{
  socket.on('json-room',(roomId,userId)=>{
      console.log(roomId,userId)
  })

})
=======
io.on('connection', socket => {
    socket.on('join-room',(roomId,userId)=>{
        console.log(roomId,userId)
        socket.join(roomId)
        socket.to(roomId).broadcast.emit('emit-connetced'.userId)
    
    })
    
    })

>>>>>>> 3b6e77272bb31607402b1af91ab37f9c60417d29
server.listen(8009)