#!/usr/bin/env node

const {
  createServer,
  IncomingMessage,
  ServerResponse,
} = require('unit-http');

require('http').ServerResponse = ServerResponse;
require('http').IncomingMessage = IncomingMessage;

const express = require('express');
const app = express();
const ObjectID = require('mongodb').ObjectID;
const axios = require('axios');
const FuzzySet = require('fuzzyset.js');

const { init, getClient, DBName } = require("./sdk.js");

// Parse JSON bodies (as sent by API clients)
app.use(express.json());
app.use(express.urlencoded());
app.engine('pug', require('pug').__express);
app.set('view engine', 'pug');
app.set('views', './views');
app.use(express.static('public'));

init(app)
  .then(() => {
    initializeRoutes();
    createServer(app).listen(); // nginx unit listen entry point
  }
);

function initializeRoutes(){
  app.post('/', async function (request, response) {
    const inboundMsg = request.body;

    // If this is a session end event, ignore
    if (inboundMsg.type == 'session_end' || inboundMsg.type == 'new_session') {
      response.end();
      return;
    }
    if (!inboundMsg.msg) {
      response.end();
      return;
    }
    if (request.body.msg.direction == 'egress') {
      response.end();
      return;
    }

    const cleanInput = inboundMsg.msg.txt.toLowerCase().trim();
    console.error('New message : ', inboundMsg.msg.src, ':', cleanInput);
    let output = await getResponse(cleanInput, request.config);
    await saveMessage({
      from: inboundMsg.msg.src,
      to: inboundMsg.msg.dst,
      received: cleanInput,
      responded: output || request.config.default_response,
      sentToSlack: request.config.slack === 'TRUE',
      sentToUser: request.config.message === 'TRUE',
      createdAt: new Date()
    });
    if (request.config.slack == 'TRUE') {
      const prefixTxt = inboundMsg.msg.src + '<->' + inboundMsg.msg.dst + ': ';
      let text = prefixTxt + 'Received ' + cleanInput + ', but found no response.';
      if (output) {
        text = prefixTxt + 'Received ' + cleanInput + ' and responded ' + output;
      }
      console.error('output', output);

      axios
        .post(request.config.slack_webhook, {
          text
        })
        .catch(error => {
          console.error(error);
        });
    }
    if (!output) {
      console.error('No close response found.');
      if (request.config.default_response) {
        console.error('Using default response.');
        output = request.config.default_response;
      } else {
        console.error('No default response.');
        response.end();
        return;
      }
    }
    console.error('Sending back a ', output);
    const jsonResp = {};
    if (request.config.message == 'TRUE') {
      jsonResp.messages = [{ txt: output }];
    }
    if (request.config.whisper == 'TRUE') {
      jsonResp.whispers = [{ txt: output }];
    }
    response.send(jsonResp);
  });

  app.get('/deleteIntent/:id', function (request, response) {
    deleteIntent(request.params.id);
    response.redirect('/');
  });

  app.get('/deleteAllIntents', function (request, response) {
    deleteAllIntents();
    response.redirect('/');
  });

  app.get('/deleteExample/:id', function (request, response) {
    deleteExample(request.params.id);
    response.redirect('/');
  });


  app.post('/new_example', function ({ body }, response) {
    if (!body.sample ||
      !body.intentId ||
      body.sample.trim() == "" ||
      body.intentId.trim() == "") {
      response.redirect('/');
    }
    else {
      addExample({ ...body, intentId: new ObjectID(body.intentId) });
      response.redirect('/');
    }
  });


  app.post('/new_intent', function (request, response) {
    if (!request.body.name ||
      !request.body.responseTxt ||
      request.body.name.trim() == "" ||
      request.body.responseTxt.trim() == "") {
      response.redirect('/');
    }
    else {
      addIntent(request.body);
      response.redirect('/');
    }
  });

  app.get('/', async function (request, response) {
    const client = await getClient();  
    try {
      await client.connect();
      const db = client.db(DBName);
      const exampleColl = db.collection('examples');
      const examples = await exampleColl.find().toArray();
      const intentColl = db.collection('intents');
      const intents = await intentColl.find().toArray();
      const version = process.env.COMMIT_HASH ? process.env.COMMIT_HASH : "";
      response.render('index', { examples, intents, config: request.config, version });
    } catch (err) {
      console.error(err);
    }
    finally {
      await client.close();
    }
  });

  app.get('/editIntent/:id', async function (request, response) {
    const client = await getClient();  
    try {
      await client.connect();
      const db = client.db(DBName);
      const intentColl = db.collection('intents');
      const intent = await intentColl.findOne({
        _id: new ObjectID(request.params.id)
      });

      if (!intent) {
        response.redirect('/');
      }

      response.render('editIntent', { title: 'Edit Intent', intent });
    } catch (err) {
      console.error(err);
    }
    finally {
      await client.close();
    }
  });

  app.post('/editIntent', async function (request, response) {
    console.error('Updating Intent: ', request.body.id);
    const client = await getClient();  
    try {
      await client.connect();
      const db = client.db(DBName);
      const intentColl = db.collection('intents');
      var intent = await intentColl.findOne({
        _id: new ObjectID(request.body.id)
      });

      if (intent) {
        await intentColl.updateOne({ _id: intent._id }, { $set: { name: request.body.name, responseTxt: request.body.responseTxt } });
      }
    } catch (err) {
      console.error(err);
    }
    finally {
      await client.close();
    }
    response.redirect('/');
  });

  app.get('/editExample/:id', async function (request, response) {
    const client = await getClient();  
    try {
      await client.connect();
      const db = client.db(DBName);
      const exampleColl = db.collection('examples');
      const example = await exampleColl.findOne({
        _id: new ObjectID(request.params.id)
      });

      if (!example) {
        response.redirect('/');
      }

      response.render('editExample', { title: 'Edit Example', example });
    } catch (err) {
      console.error(err);
    }
    finally {
      await client.close();
    }
  });

  app.post('/editExample', async function (request, response) {
    console.error('Updating Example: ', request.body.id);
    const client = await getClient();  
    try {
      await client.connect();
      const db = client.db(DBName);
      const exampleColl = db.collection('examples');
      var example = await exampleColl.findOne({
        _id: new ObjectID(request.body.id)
      });

      if (example) {
        await exampleColl.updateOne({ _id: example._id }, { $set: { sample: request.body.sample } });
      }
    } catch (err) {
      console.error(err);
    }
    finally {
      await client.close();
    }
    response.redirect('/');
  });

}

async function getResponse(inputText, config) {
  let responseText;
  const client = await getClient();
  try {
    await client.connect();
    const db = client.db(DBName);
    const exampleColl = db.collection('examples');
    const examples = await exampleColl.find({}).toArray();
    const sampleSet = examples.map(example => example.sample);
    const search = FuzzySet(sampleSet);
    nearestMatch = search.get(inputText);
    if (!nearestMatch) {
      console.error('No match found in fuzzy search');
      return;
    }
    nearestScore = nearestMatch[0][0];
    nearestSample = nearestMatch[0][1];
    console.error('Nearest match ', nearestScore, nearestSample);
    let reqScore = 0.8;
    if (config.score) {
      reqScore = Number(config.score);
    }
    console.error('Required score is ', reqScore);
    if (nearestScore > reqScore) {
      console.error('We have a match!');
      const selectedExample = await exampleColl.findOne({
        sample: nearestSample
      });
      console.error('Found matching example ', selectedExample);
      const intentColl = db.collection('intents');
      const nearestIntent = await intentColl.findOne({
        _id: selectedExample.intentId
      });
      console.error('Found matching intent ', nearestIntent);
      if (nearestIntent) {
        responseText = nearestIntent.responseTxt;
      } else {
        console.error('No response found');
      }
    } else {
      console.error('No close enough response found');
    }
    console.error('Responding with a ', responseText);
  } catch (err) {
    console.error(err);
  }
  finally {
    await client.close();
  }
  return responseText;
}

async function saveMessage(message) {
  const client = await getClient();  
  try {
    await client.connect();
    const db = client.db(DBName);
    let messagesCollection = db.collection('seenMessages');
    await messagesCollection.insertOne(message);
  } catch (err) {
    console.error(err);
  }
  finally {
    await client.close();
  }
}

// Access the parse results as request.body


async function deleteIntent(_id) {
  console.error('Deleting intent and examples ', _id);
  const client = await getClient();
  try {
    await client.connect();
    const db = client.db(DBName);
    const intentCollection = db.collection('intents');
    await intentCollection.deleteOne({ _id: new ObjectID(_id) });
    const exampleCollection = db.collection('examples');
    await exampleCollection.deleteMany({ intentId: new ObjectID(_id) });
  } catch (err) {
    console.error(err);
  }
  finally {
    await client.close();
  }
}

async function deleteAllIntents() {
  console.error('Deleting all intents...');
  const client = await getClient();
  try {
    await client.connect();
    const db = client.db(DBName);
    const intentCollection = db.collection('intents');
    await intentCollection.deleteMany({ });
    const exampleCollection = db.collection('examples');
    await exampleCollection.deleteMany({ });
  } catch (err) {
    console.error(err);
  }
  finally {
    await client.close();
  }
}

async function deleteExample(_id) {
  console.error('Deleting examples ', _id);
  const client = await getClient();
  try {
    await client.connect();
    const db = client.db(DBName);
    const collection = db.collection('examples');
    await collection.deleteOne({ _id: new ObjectID(_id) });
  } catch (err) {
    console.error(err);
  }
  finally {
    await client.close();
  }
}

async function addExample(example) {
  const client = await getClient();
  try {
    await client.connect();
    const db = client.db(DBName);
    const collection = db.collection('examples');
    await collection.insertOne(example);
  } catch (err) {
    console.error(err);
  }
  finally {
    await client.close();
  }
}

async function addIntent(intent) {
  const client = await getClient();
  try {
    await client.connect();
    const db = client.db(DBName);
    const collection = db.collection('intents');
    await collection.insertOne(intent);
  } catch (err) {
    console.error(err);
  }
  finally {
    await client.close();
  }
}

//http.listen(port, () => log(`SeeSomething running on ${port}!`));
