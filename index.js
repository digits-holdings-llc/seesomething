const express = require('express')
const app = express()
var http = require('http').createServer(app);

const port = process.env.WEB_PORT || 80
var MongoClient = require('mongodb').MongoClient
const ObjectID = require('mongodb').ObjectID
const { GraphQLClient } = require('graphql-request')
const mongoURL = process.env.MONGO_URL || 'mongodb://localhost:27017/seesomething'
const parts = mongoURL.split("/")
const DB_NAME = parts[parts.length - 1]
var contactTimeout
var botSDK = require('greenbot-sdk')
const axios = require('axios')

// Parse JSON bodies (as sent by API clients)
app.use(express.json());
app.use(express.urlencoded());
app.engine('pug', require('pug').__express)
app.set('view engine', 'pug')
app.set('views', './views')
app.use(express.static('public'))
botSDK.init(app, http)

async function getResponse(inputText, config) {
  const client = await MongoClient.connect(mongoURL).catch(err => {botSDK.log("Mongo Client Connect error", err)})
  try {
    const db = client.db(DB_NAME)
    let respColl = db.collection('responses')
    var response = await respColl.findOne({inputText})
    var responseText
    if (response) {
      responseText = response.response
      botSDK.log(inputText + ":" + responseText)
    } else {
      botSDK.log("No response found for ", inputText, "so using default if any")
      responseText = config.default_response
    }
  } catch (err) {
    botSDK.log(err);
  } finally {
    client.close();
  }
  return responseText
}


// Access the parse results as request.body
app.post('/', async function(request, response) {
  var inboundMsg = request.body;

  // If this is a session end event, ignore
  if (inboundMsg.type == 'session_end' || inboundMsg.type == 'new_session') {
    response.send({})
    return;
  }
  if (!inboundMsg.msg) {
    response.send({})
    return;
  }
  if (request.body.msg.direction == "egress") {
    response.send({})
    return;
  }

  const cleanInput = inboundMsg.msg.txt.toLowerCase().trim()
  botSDK.log("New message : ", inboundMsg.msg.src, ":", cleanInput)
  var output = await getResponse(cleanInput, request.config)
  botSDK.log("Sending back a ", output)
  var jsonResp = {}
  if (request.config.message=="TRUE") {
    jsonResp.messages = [{ txt: output}]
  }
  if (request.config.whisper=="TRUE") {
    jsonResp.whispers = [{ txt: output}]
  }
  if (request.config.slack == "TRUE") {
    const prefixTxt = inboundMsg.msg.src + "<->" + inboundMsg.msg.dst + ": "
    var text = prefixTxt + "Received " + cleanInput + ", but found no response."
    if (output) {
      text = prefixTxt + "Received " + cleanInput + " and responded " + output
    }
    axios.post(request.config.slack_webhook, {
      text
    })
    .catch((error) => {
      console.error(error)
    })
  }
  response.send(jsonResp)
})

async function deleteResponse(_id) {
  botSDK.log("Deleteing response ", _id)
  const client = await MongoClient.connect(mongoURL).catch(err => {botSDK.log("Mongo Client Connect error", err)})
  if (!client) {
    return;
  }
  try {
    const db = client.db(DB_NAME)
    let collection = db.collection('responses')
    await collection.deleteOne({_id: new ObjectID(_id)})
  } catch (err) {
    botSDK.log(err);
  } finally {
    client.close();
  }
}


app.get('/delete/:id', function(request, response) {
  deleteResponse(request.params.id)
  response.redirect("/")
})

async function add(response) {
  const client = await MongoClient.connect(mongoURL).catch(err => {botSDK.log("Mongo Client Connect error", err)})
  if (!client) {
    return;
  }
  try {
    const db = client.db(DB_NAME)
    let collection = db.collection('responses')
    await collection.insertOne(response)
  } catch (err) {
    botSDK.log(err);
  } finally {
    client.close();
  }
}


app.post('/new_response', function(request, response) {
  add(request.body)
  response.redirect("/")
  })

app.get('/', async function(request, response) {
  const client = await MongoClient.connect(mongoURL).catch(err => {botSDK.log("Mongo Client Connect error", err)})
  try {
    const db = client.db(DB_NAME)
    let respColl = db.collection('responses')
    var responses = await respColl.find().toArray()
    response.render('index', { responses, config: request.config})
  } catch (err) {
    botSDK.log(err);
  } finally {
    client.close();
  }
})

http.listen(port, () => botSDK.log(`Automation running on ${port}!`))
