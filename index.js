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
const FuzzySet = require('fuzzyset.js')

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
    let exampleColl = db.collection('examples')
    var examples = await exampleColl.find({}).toArray()
    var sampleSet = examples.map(example => example.sample)
    var search = FuzzySet(sampleSet)
    var responseText
    nearestMatch = search.get(inputText)
    if (!nearestMatch) {
      console.log("No match found in fuzzy search")
      return
    }
    nearestScore = nearestMatch[0][0]
    nearestSample = nearestMatch[0][1]
    console.log("Nearest match ", nearestScore, nearestSample)
    var reqScore = 0.8
    if (config.score) {
      reqScore = Number(config.score)
    }
    console.log("Required score is ", reqScore)
    if (nearestScore > reqScore) {
      console.log("We have a match!")
      let selectedExample = await exampleColl.findOne({sample: nearestSample})
      console.log("Found matching example ", selectedExample)
      let intentColl = db.collection('intents')
      var nearestIntent = await intentColl.findOne({_id: new ObjectID(selectedExample.intentId)})
      console.log("Found matching intent ", nearestIntent)
      if (nearestIntent) {
        responseText = nearestIntent.responseTxt
      } else {
        botSDK.log("No response found")
      }
    } else {
      botSDK.log("No close enough response found")
    }
    botSDK.log("Responding with a ", responseText)
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
  if (!output) {
    botSDK.log("No close response found.")
    if (request.config.default_response) {
      botSDK.log("Using default response.")
      output = request.config.default_response
    } else {
      botSDK.log("No default response.")
      response.send({})
      return;
    }
  }
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

async function deleteIntent(_id) {
  botSDK.log("Deleting intent and examples ", _id)
  const client = await MongoClient.connect(mongoURL).catch(err => {botSDK.log("Mongo Client Connect error", err)})
  if (!client) {
    return;
  }
  try {
    const db = client.db(DB_NAME)
    let collection = db.collection('intents')
    await collection.deleteOne({_id: new ObjectID(_id)})
    collection = db.collection('examples')
    await collection.deleteMany({intentId: _id})
  } catch (err) {
    botSDK.log(err);
  } finally {
    client.close();
  }
}

async function deleteExample(_id) {
  botSDK.log("Deleteing examples ", _id)
  const client = await MongoClient.connect(mongoURL).catch(err => {botSDK.log("Mongo Client Connect error", err)})
  if (!client) {
    return;
  }
  try {
    const db = client.db(DB_NAME)
    let collection = db.collection('examples')
    await collection.deleteOne({_id: new ObjectID(_id)})
  } catch (err) {
    botSDK.log(err);
  } finally {
    client.close();
  }
}


app.get('/deleteIntent/:id', function(request, response) {
  deleteIntent(request.params.id)
  response.redirect("/")
})
app.get('/deleteExample/:id', function(request, response) {
  deleteExample(request.params.id)
  response.redirect("/")
})

async function addExample(example) {
  const client = await MongoClient.connect(mongoURL).catch(err => {botSDK.log("Mongo Client Connect error", err)})
  if (!client) {
    return;
  }
  try {
    const db = client.db(DB_NAME)
    let collection = db.collection('examples')
    await collection.insertOne(example)
  } catch (err) {
    botSDK.log(err);
  } finally {
    client.close();
  }
}


app.post('/new_example', function(request, response) {
  addExample(request.body)
  response.redirect("/")
  })

async function addIntent(intent) {
  const client = await MongoClient.connect(mongoURL).catch(err => {botSDK.log("Mongo Client Connect error", err)})
  if (!client) {
    return;
  }
  try {
    const db = client.db(DB_NAME)
    let collection = db.collection('intents')
    await collection.insertOne(intent)
  } catch (err) {
    botSDK.log(err);
  } finally {
    client.close();
  }
}


app.post('/new_intent', function(request, response) {
  addIntent(request.body)
  response.redirect("/")
  })


app.get('/', async function(request, response) {
  const client = await MongoClient.connect(mongoURL).catch(err => {botSDK.log("Mongo Client Connect error", err)})
  try {
    const db = client.db(DB_NAME)
    let exampleColl = db.collection('examples')
    var examples = await exampleColl.find().toArray()
    let intentColl = db.collection('intents')
    var intents = await intentColl.find().toArray()
    response.render('index', { examples, intents, config: request.config})
  } catch (err) {
    botSDK.log(err);
  } finally {
    client.close();
  }
})

http.listen(port, () => botSDK.log(`SeeSomething running on ${port}!`))
