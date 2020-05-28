#!/usr/bin/env node

const {
  createServer,
  IncomingMessage,
  ServerResponse,
} = require('unit-http');

const port = parseInt(process.env.PORT);
const portIsInvalid = Number.isNaN(port);
if (portIsInvalid) {
  require('http').ServerResponse = ServerResponse;
  require('http').IncomingMessage = IncomingMessage;
}

const { initSDK, app, logger, ORGANIZATION_ID } = require('vht-automations-sdk');
const applicationName = "See Something Say Something";
const axios = require('axios');
const FuzzySet = require('fuzzyset.js');
const express = require("express");
const ObjectID = require('mongodb').ObjectID;

app.use(express.static('public'));

initSDK({applicationName, pug_views: ["views"]})
  .then(() => { 
    initializeRoutes();        
    if (portIsInvalid) {
      createServer(app).listen(); // nginx unit listen entry point
    }
    else {
      const http = require('http').createServer(app);
      http.listen(port, () => logger.info(`${applicationName} running on ${port}!`));
    }
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
    request.logger.info('New message : ', inboundMsg.msg.src, ':', cleanInput);
    let output = await getResponse(request, cleanInput, request.config);
    await saveMessage({
      from: inboundMsg.msg.src,
      to: inboundMsg.msg.dst,
      received: cleanInput,
      responded: output || request.config.default_response,
      sentToSlack: request.config.slack === 'TRUE',
      sentToUser: request.config.message === 'TRUE',
      createdAt: new Date()
    }, request);
    if (request.config.slack == 'TRUE') {
      const prefixTxt = inboundMsg.msg.src + '<->' + inboundMsg.msg.dst + ': ';
      let text = prefixTxt + 'Received ' + cleanInput + ', but found no response.';
      if (output) {
        text = prefixTxt + 'Received ' + cleanInput + ' and responded ' + output;
      }
      request.logger.info('output', output);

      axios
        .post(request.config.slack_webhook, {
          text
        })
        .catch(error => {
          request.logger.error(error);
        });
    }
    if (!output) {
      request.logger.info('No close response found.');
      if (request.config.default_response) {
        request.logger.info('Using default response.');
        output = request.config.default_response;
      } else {
        request.logger.info('No default response.');
        response.end();
        return;
      }
    }
    request.logger.info('Sending back a ', output);
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
    deleteIntent(request);
    response.redirect('/');
  });

  app.get('/deleteAllIntents', function (request, response) {
    deleteAllIntents(request);
    response.redirect('/');
  });

  app.get('/deleteExample/:id', function (request, response) {
    deleteExample(request);
    response.redirect('/');
  });


  app.post('/new_example', function (request, response) {
    const body = request.body;
    if (!body.sample ||
      !body.intentId ||
      body.sample.trim() == "" ||
      body.intentId.trim() == "") {
      response.redirect('/');
    }
    else {
      addExample({ ...body, intentId: new ObjectID(body.intentId) }, request);
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
      addIntent(request.body, request);
      response.redirect('/');
    }
  });

  app.get('/', async function (request, response) {
    try {
      await request.mongoClient.connect();
      const db = request.mongoClient.db(request.mongoDatabaseName);
      const exampleColl = db.collection('examples');
      const examples = await exampleColl.find().toArray();
      const intentColl = db.collection('intents');
      const intents = await intentColl.find().toArray();
      const version = process.env.COMMIT_HASH ? process.env.COMMIT_HASH : "";
      response.render('index', { examples, intents, config: request.config, version });
    } catch (err) {
      request.logger.error(err);
    }
    finally {
      await request.mongoClient.close();
    }
  });

  app.get('/editIntent/:id', async function (request, response) {
    try {
      await request.mongoClient.connect();
      const db = request.mongoClient.db(request.mongoDatabaseName);
      const intentColl = db.collection('intents');
      const intent = await intentColl.findOne({
        _id: new ObjectID(request.params.id)
      });

      if (!intent) {
        response.redirect('/');
      }

      response.render('editIntent', { title: 'Edit Intent', intent });
    } catch (err) {
      request.logger.error(err);
    }
    finally {
      await request.mongoClient.close();
    }
  });

  app.post('/editIntent', async function (request, response) {
    request.logger.info('Updating Intent: ', request.body.id);  
    try {
      await request.mongoClient.connect();
      const db = request.mongoClient.db(request.mongoDatabaseName);
      const intentColl = db.collection('intents');
      var intent = await intentColl.findOne({
        _id: new ObjectID(request.body.id)
      });

      if (intent) {
        await intentColl.updateOne({ _id: intent._id }, { $set: { name: request.body.name, responseTxt: request.body.responseTxt } });
      }
    } catch (err) {
      request.logger.error(err);
    }
    finally {
      await request.mongoClient.close();
    }
    response.redirect('/');
  });

  app.get('/editExample/:id', async function (request, response) {
    try {
      await request.mongoClient.connect();
      const db = request.mongoClient.db(request.mongoDatabaseName);
      const exampleColl = db.collection('examples');
      const example = await exampleColl.findOne({
        _id: new ObjectID(request.params.id)
      });

      if (!example) {
        response.redirect('/');
      }

      response.render('editExample', { title: 'Edit Example', example });
    } catch (err) {
      request.logger.error(err);
    }
    finally {
      await request.mongoClient.close();
    }
  });

  app.post('/editExample', async function (request, response) {
    request.logger.info('Updating Example: ', request.body.id);
    try {
      await request.mongoClient.connect();
      const db = request.mongoClient.db(request.mongoDatabaseName);
      const exampleColl = db.collection('examples');
      var example = await exampleColl.findOne({
        _id: new ObjectID(request.body.id)
      });

      if (example) {
        await exampleColl.updateOne({ _id: example._id }, { $set: { sample: request.body.sample } });
      }
    } catch (err) {
      request.logger.error(err);
    }
    finally {
      await request.mongoClient.close();
    }
    response.redirect('/');
  });

}

async function getResponse(request, inputText, config) {
  let responseText;
  try {
    await request.mongoClient.connect();
    const db = request.mongoClient.db(request.mongoDatabaseName);
    const exampleColl = db.collection('examples');
    const examples = await exampleColl.find({}).toArray();
    const sampleSet = examples.map(example => example.sample);
    const search = FuzzySet(sampleSet);
    nearestMatch = search.get(inputText);
    if (!nearestMatch) {
      request.logger.info('No match found in fuzzy search');
      return;
    }
    nearestScore = nearestMatch[0][0];
    nearestSample = nearestMatch[0][1];
    request.logger.info('Nearest match ', nearestScore, nearestSample);
    let reqScore = 0.8;
    if (config.score) {
      reqScore = Number(config.score);
    }
    request.logger.info('Required score is ', reqScore);
    if (nearestScore > reqScore) {
      request.logger.info('We have a match!');
      const selectedExample = await exampleColl.findOne({
        sample: nearestSample
      });
      request.logger.info('Found matching example ', selectedExample);
      const intentColl = db.collection('intents');
      const nearestIntent = await intentColl.findOne({
        _id: selectedExample.intentId
      });
      request.logger.info('Found matching intent ', nearestIntent);
      if (nearestIntent) {
        responseText = nearestIntent.responseTxt;
      } else {
        request.logger.info('No response found');
      }
    } else {
      request.logger.info('No close enough response found');
    }
    request.logger.info('Responding with a ', responseText);
  } catch (err) {
    request.logger.error(err);
  }
  finally {
    await request.mongoClient.close();
  }
  return responseText;
}

async function saveMessage(message, request) {
  try {
    await request.mongoClient.connect();
    const db = request.mongoClient.db(request.mongoDatabaseName);
    let messagesCollection = db.collection('seenMessages');
    await messagesCollection.insertOne(message);
  } catch (err) {
    request.logger.error(err);
  }
  finally {
    await request.mongoClient.close();
  }
}

async function deleteIntent(request) {
  const _id = request.params.id;
  request.logger.info('Deleting intent and examples ', _id);
  try {
    await request.mongoClient.connect();
    const db = request.mongoClient.db(request.mongoDatabaseName);
    const intentCollection = db.collection('intents');
    await intentCollection.deleteOne({ _id: new ObjectID(_id) });
    const exampleCollection = db.collection('examples');
    await exampleCollection.deleteMany({ intentId: new ObjectID(_id) });
  } catch (err) {
    request.logger.error(err);
  }
  finally {
    await request.mongoClient.close();
  }
}

async function deleteAllIntents(request) {
  request.logger.info('Deleting all intents...');
  try {
    await request.mongoClient.connect();
    const db = request.mongoClient.db(request.mongoDatabaseName);
    const intentCollection = db.collection('intents');
    await intentCollection.deleteMany({ });
    const exampleCollection = db.collection('examples');
    await exampleCollection.deleteMany({ });
  } catch (err) {
    request.logger.error(err);
  }
  finally {
    await request.mongoClient.close();
  }
}

async function deleteExample(request) {
  const _id = request.params.id;
  request.logger.info('Deleting examples ', _id);
  try {
    await request.mongoClient.connect();
    const db = request.mongoClient.db(request.mongoDatabaseName);
    const collection = db.collection('examples');
    await collection.deleteOne({ _id: new ObjectID(_id) });
  } catch (err) {
    request.logger.error(err);
  }
  finally {
    await request.mongoClient.close();
  }
}

async function addExample(example, request) {
  try {
    await request.mongoClient.connect();
    const db = request.mongoClient.db(request.mongoDatabaseName);
    const collection = db.collection('examples');
    await collection.insertOne(example);
  } catch (err) {
    request.logger.error(err);
  }
  finally {
    await request.mongoClient.close();
  }
}

async function addIntent(intent, request) {
  try {
    await request.mongoClient.connect();
    const db = request.mongoClient.db(request.mongoDatabaseName);
    const collection = db.collection('intents');
    await collection.insertOne(intent);
  } catch (err) {
    request.logger.error(err);
  }
  finally {
    await request.mongoClient.close();
  }
}
