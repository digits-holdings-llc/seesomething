const express = require('express');
const app = express();
const http = require('http').createServer(app);
const port = process.env.WEB_PORT || 80;
const ObjectID = require('mongodb').ObjectID;
const SUBDOMAIN = process.env.SUBDOMAIN;
const { init, log, client } = require('greenbot-sdk');
const axios = require('axios');
const FuzzySet = require('fuzzyset.js');

// Parse JSON bodies (as sent by API clients)
app.use(express.json());
app.use(express.urlencoded());
app.engine('pug', require('pug').__express);
app.set('view engine', 'pug');
app.set('views', './views');
app.use(express.static('public'));
init(app, http);

async function getResponse(inputText, config) {
  let responseText;
  try {
    const db = client.db(SUBDOMAIN);
    const exampleColl = db.collection('examples');
    const examples = await exampleColl.find({}).toArray();
    const sampleSet = examples.map(example => example.sample);
    const search = FuzzySet(sampleSet);
    nearestMatch = search.get(inputText);
    if (!nearestMatch) {
      console.log('No match found in fuzzy search');
      return;
    }
    nearestScore = nearestMatch[0][0];
    nearestSample = nearestMatch[0][1];
    console.log('Nearest match ', nearestScore, nearestSample);
    let reqScore = 0.8;
    if (config.score) {
      reqScore = Number(config.score);
    }
    console.log('Required score is ', reqScore);
    if (nearestScore > reqScore) {
      console.log('We have a match!');
      const selectedExample = await exampleColl.findOne({
        sample: nearestSample
      });
      console.log('Found matching example ', selectedExample);
      const intentColl = db.collection('intents');
      const nearestIntent = await intentColl.findOne({
        _id: selectedExample.intentId
      });
      console.log('Found matching intent ', nearestIntent);
      if (nearestIntent) {
        responseText = nearestIntent.responseTxt;
      } else {
        log('No response found');
      }
    } else {
      log('No close enough response found');
    }
    log('Responding with a ', responseText);
  } catch (err) {
    log(err);
  }
  return responseText;
}

async function saveMessage(message) {
  try {
    const db = client.db(SUBDOMAIN);
    let messagesCollection = db.collection('seenMessages');
    await messagesCollection.insertOne(message);
  } catch (err) {
    log(err);
  }
}

// Access the parse results as request.body
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
  log('New message : ', inboundMsg.msg.src, ':', cleanInput);
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
    console.log('output', output);

    axios
      .post(request.config.slack_webhook, {
        text
      })
      .catch(error => {
        console.error(error);
      });
  }
  if (!output) {
    log('No close response found.');
    if (request.config.default_response) {
      log('Using default response.');
      output = request.config.default_response;
    } else {
      log('No default response.');
      response.end();
      return;
    }
  }
  log('Sending back a ', output);
  const jsonResp = {};
  if (request.config.message == 'TRUE') {
    jsonResp.messages = [{ txt: output }];
  }
  if (request.config.whisper == 'TRUE') {
    jsonResp.whispers = [{ txt: output }];
  }
  response.send(jsonResp);
});

async function deleteIntent(_id) {
  log('Deleting intent and examples ', _id);
  if (!client) {
    return;
  }
  try {
    const db = client.db(SUBDOMAIN);
    const intentCollection = db.collection('intents');
    await intentCollection.deleteOne({ _id: new ObjectID(_id) });
    const exampleCollection = db.collection('examples');
    await exampleCollection.deleteMany({ intentId: new ObjectID(_id) });
  } catch (err) {
    log(err);
  }
}

async function deleteExample(_id) {
  log('Deleteing examples ', _id);
  if (!client) {
    return;
  }
  try {
    const db = client.db(SUBDOMAIN);
    const collection = db.collection('examples');
    await collection.deleteOne({ _id: new ObjectID(_id) });
  } catch (err) {
    log(err);
  }
}

app.get('/deleteIntent/:id', function (request, response) {
  deleteIntent(request.params.id);
  response.redirect('/');
});
app.get('/deleteExample/:id', function (request, response) {
  deleteExample(request.params.id);
  response.redirect('/');
});

async function addExample(example) {
  if (!client) {
    return;
  }
  try {
    const db = client.db(SUBDOMAIN);
    const collection = db.collection('examples');
    await collection.insertOne(example);
  } catch (err) {
    log(err);
  }
}

app.post('/new_example', function ({ body }, response) {
  addExample({ ...body, intentId: new ObjectID(body.intentId) });
  response.redirect('/');
});

async function addIntent(intent) {
  if (!client) {
    return;
  }
  try {
    const db = client.db(SUBDOMAIN);
    const collection = db.collection('intents');
    await collection.insertOne(intent);
  } catch (err) {
    log(err);
  }
}

app.post('/new_intent', function (request, response) {
  addIntent(request.body);
  response.redirect('/');
});

app.get('/', async function (request, response) {
  try {
    const db = client.db(SUBDOMAIN);
    const exampleColl = db.collection('examples');
    const examples = await exampleColl.find().toArray();
    const intentColl = db.collection('intents');
    const intents = await intentColl.find().toArray();
    const version = process.env.COMMIT_HASH ? process.env.COMMIT_HASH : "";
    response.render('index', { examples, intents, config: request.config,version });
  } catch (err) {
    log(err);
  }
});

app.get('/editIntent/:id', async function (request, response) {
  try {
    const db = client.db(SUBDOMAIN);
    const intentColl = db.collection('intents');
    const intent = await intentColl.findOne({
      _id: new ObjectID(request.params.id)
    });

    if (!intent) {
      response.redirect('/');
    }

    response.render('editIntent', { title: 'Edit Intent', intent });
  } catch (err) {
    log(err);
  }
});

app.post('/editIntent', async function (request, response) {
  log('Updating Intent: ', request.body.id);
  try {
    const db = client.db(SUBDOMAIN);
    const intentColl = db.collection('intents');
    var intent = await intentColl.findOne({
      _id: new ObjectID(request.body.id)
    });

    if (intent) {
      await intentColl.updateOne({ _id: intent._id}, { $set: {name: request.body.name, responseTxt: request.body.responseTxt}});
    }    
  } catch (err) {
    log(err);
  }
  response.redirect('/');
});

app.get('/editExample/:id', async function (request, response) {
  try {
    const db = client.db(SUBDOMAIN);
    const exampleColl = db.collection('examples');
    const example = await exampleColl.findOne({
      _id: new ObjectID(request.params.id)
    });

    if (!example) {
      response.redirect('/');
    }

    response.render('editExample', { title: 'Edit Example', example });
  } catch (err) {
    log(err);
  }
});

app.post('/editExample', async function (request, response) {
  log('Updating Example: ', request.body.id);
  try {
    const db = client.db(SUBDOMAIN);
    const exampleColl = db.collection('examples');
    var example = await exampleColl.findOne({
      _id: new ObjectID(request.body.id)
    });

    if (example) {
      await exampleColl.updateOne({ _id: example._id}, { $set: {sample: request.body.sample}});
    }    
  } catch (err) {
    log(err);
  }
  response.redirect('/');
});

http.listen(port, () => log(`SeeSomething running on ${port}!`));
