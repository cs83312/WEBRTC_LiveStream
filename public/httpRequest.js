var http = require('http');


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
        alert(Http.responseText);
        console.log(Http.responseText)
    }
}