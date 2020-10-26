import { MgSdk } from "./mgsdk.js";
var http = require('http');
const { resourceUsage } = require('process');


function sendLogin()
{
    const params={
        email:"a410121060@gmail.com",
        password:"zxc"
    }
   const  serverhost="http://122.117.147.10:5000";
   
    const Http = new XMLHttpRequest();
    Http.open("POST",serverhost+"/users/login");
    Http.setRequestHeader("Content-Type","application/json; charset=utf-8");
    Http.send(JSON.stringify(params));

    
    Http.onreadystatechange=(e)=>{
        var body = JSON.parse(Http.responseText);

        console.log(Http.responseText);
        document.getElementById("callresult").innerHTML=body.roomid;
    }
}

function sendStreamRequest(){

    var roomid="1602644143655";
    var uri="wss://api.mgmeet.io/api/adapters/sp/v1/ws/";
    var token="eyJhbGciOiJFZERTQSJ9.eyJjb25maWciOnsibmFtZSI6IjE2MDI2NDQxNDM2NTUiLCJiYW5kd2lkdGgiOjEwMjQwLCJyeENvdW50Ijo0LCJleHBpcnkiOiIyMDIwLTEwLTE5VDE1OjAyOjI1WiJ9LCJleHAiOjE2MDMxMTk3NDUsInJvbGUiOiJyeCIsInN1YiI6ImJ1NmczZ3FocDlwYzY1a2NndDEwIiwidXJpIjoid3NzOi8vYXBpLm1nbWVldC5pby9hcGkvYWRhcHRlcnMvc3AvdjEvd3MvMTYwMjY0NDE0MzY1NSJ9.xrghoZ6D3icUcj4fhAId2fxfmvod49vGyNJ1g1BHYbmmoxug3w5DFce1X4U9fkcI7uVAT2bWYTHdsmqVe2q9CQ";
    conn = MgSdk.connect("spRx",uri,token,null,"zxc");

    conn.onclose = async () => {
        console.log("onclose");
        this.setRemoteVideo(null);
      };

      conn.onsignalingstatechange = async () => {
        console.log("onsignalingstatechange", this.conn.signalingState);
      };

      conn.oniceconnectionstatechange = async () => {
        console.log("oniceconnectionstatechange", this.conn.iceConnectionState);
      };

      conn.ontrack = async evt => {
        console.log("ontrack");
        this.setRemoteVideo(evt.streams[0]);
      };
}