console.log("Starting RTC...")

const express = require("express")
const app = express()
const port = 8009;
const { v4: uuidV4 } = require('uuid')

const server = require('http').Server(app).listen(port,()=>{
    console.log(`Listening on  app ${app} port ${port}...`);
})

const io = require('socket.io')(server)

app.set('view engine','ejs')
app.use(express.static('public'))
//if you in root then redirect to root+roomId
app.get('/',(req,res) => {
    res.render('room',{roomId: req.params.room})
    //res.redirect(`/${uuidV4()}`)

    })

app.get('/:room',(req,res)=> {
res.render('room',{roomId: req.params.room})
})
// we have some stage need to execute
// 1. send room number to join room
// 2. findNowRoom to check user is in room or not
// 3. peerconnectSignaling send each user sdp

function findNowRoom(client){
    return Object.keys(client.rooms).find(item=>{
    return item!==client.id
    });
}

io.on('connection',client=>{
    console.log(`socket user connecting.. ${client.id}`);

    client.on('joinRoom',room=>{
        console.log(room);

        const nowRoom =findNowRoom(client);
        if(nowRoom){
            client.leave(nowRoom);
        }
        client.join(room,()=>{
            io.sockets.in(room).emit('roomBroadcast', '已有新人加入聊天室！');
        });
    });

        client.on('peerconnectSignaling',message=>{
            console.log('接收資料：', message);

            const nowRoom = findNowRoom(client);
            client.to(nowRoom).emit('peerconnectSignaling', message)
          });
        
          client.on('disconnect', () => {
            console.log(`socket 用戶離開 ${client.id}`);
          });
});
