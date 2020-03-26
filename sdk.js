require('winston-daily-rotate-file');

const yaml = require('js-yaml');
const fs = require('fs');
const _ = require('lodash');
const winston = require('winston');
const expressWinston = require('express-winston');
const cookieParser = require('cookie-parser');
const shortid = require('shortid');
const MongoClient = require('mongodb').MongoClient;
const { authInit, getToken, verifyToken } = require("./auth.js");

const DBName = process.env.DBNAME;
const MONGO_CLUSTER_URL = process.env.MONGO_CLUSTER_URL;
const MONGO_URL = `${MONGO_CLUSTER_URL}/${DBName}/?retryWrites=true&w=majority` || `mongodb://localhost:27017/${DBName}`;

const LOGIN_PATH_URL = '/login';
const LOGOUT_PATH_URL = '/logout';

const AUTOMATION_NAME = process.env.AUTOMATION_NAME || 'automations';

var LOG_DIRECTORY = process.env.LOG_DIRECTORY || '/var/log/';
LOG_DIRECTORY = LOG_DIRECTORY.endsWith('/') ? LOG_DIRECTORY : LOG_DIRECTORY + '/';

const LOGGER_OPTIONS = {
  levels: winston.config.npm.levels,
  transports: [
    new (winston.transports.DailyRotateFile)({
      filename: `${LOG_DIRECTORY}/${AUTOMATION_NAME}-%DATE%.log`,
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '25m',
      maxFiles: '14d'
    })
  ]
};

async function getClient() {
  const client = new MongoClient(MONGO_URL, { useNewUrlParser: true, useUnifiedTopology: true });
  return client;
}  
  
async function checkConfig() {
  const client = await getClient();
  let config;
  try {
    await client
      .connect()
      .catch(err => {
        console.error('Mongo Client Connect error', err);
      })
      .then(result => {
        console.error('SDK Connected');
      });

    const db = client.db(DBName);
    const configColl = db.collection('config');
    config = await configColl.findOne();
    console.error(config);

    if (!config) {
      // read the yaml, convert to JSON
      // Stick it in the config database
      const doc = yaml.safeLoad(fs.readFileSync('./config.yaml', 'utf8'));

      // If there isn't a unique_id in the config, add one
      if (!doc.unique_id) {
        doc.unique_id = shortid.generate();
      }
      await configColl.insertOne(doc);
      config = doc;
    }
  } catch (err) {
    console.error(err);
  }
  finally {
    await client.close();
  }
  return config;
}
  
async function fetchConfig() {
  const client = await getClient();
  let config;
  try {
    await client.connect();
    const db = client.db(DBName);
    const configColl = db.collection('config');
    config = await configColl.findOne();
  } catch (err) {
    console.log(err);
  }
  finally {
    await client.close();
  }
  return config;
}

const updateConfig = async function (request, response) {
  await saveConfigData(request.body);
  response.redirect('/config');
};

const updateConfigJson = async function (request, response) {
  const error = await saveConfigData(request.body);
  if (error) {
    response.sendStatus(500);
  } else {
    response.sendStatus(200);
  }
};

async function saveConfigData(json) {
  let hasError = false;
  const client = await getClient();

  try {
    await client.connect()
    const db = client.db(DBName);
    const configColl = db.collection('config');
    await configColl.updateMany({}, { $set: json });
  } catch (err) {
    hasError = true;
    console.log(err);
  }
  finally {
    await client.close();
  }

  return hasError;
}
  
const clearCollection = async function (request, response) {
  const client = await getClient();
  if (!client) {
    return;
  }
  try {
    await client.connect();
    const db = client.db(DBName);
    const col = await db.collection(request.params.collection);

    if (col) {
      await col.deleteMany({});
    }
  } catch (err) {
    console.log('Error caught in trace function');
    console.log(err);
  }
  finally {
    await client.close();
  }

  response.redirect('/config');
};
  
const getConfig = async function (request, response) {
  config = request.config;
  delete config._id;

  // iterate over the keys of the config object
  // and make a label for each one
  config.labels = {};
  for (const prop in config) {
    config.labels[prop] = _.startCase(prop);
  }

  const collections = await getAllMongoCollections();
  response.render('config', { title: '@Services', config, collections: collections });
};


async function getAllMongoCollections() {
  const client = await getClient();
  if (!client) {
    return;
  }
  try {
    await client.connect();
    const db = client.db(DBName);
    const result = await db.listCollections().toArray();

    for (let i = 0; i < result.length; i++) {
      const name = result[i].name;
      const col = await db.collection(name);
      result[i] = await col.stats();
      result[i].name = name;
      result[i].size = (result[i].size / 1024 / 1024).toFixed(3);
    }

    return result.sort(function (a, b) {
      return a.name > b.name ? 1 : a.name < b.name ? -1 : 0;
    });
  } catch (err) {
    console.log('Error caught in trace function');
    console.log(err);
  }
  finally {
    await client.close();
  }
}

const getConfigJson = async function (request, response) {
  config = request.config;
  delete config._id;
  
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(config));
};
  
const getMetaData = async function (request, response) {
  const metaData = require('./package.json');
  
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(metaData));
};

const configMiddleware = async (req, res, next) => {
  const config = await fetchConfig();
  req.config = config;
  next();
};

const loginPage = function (req, res) {
  res.render('login');
};
  
const loginValidate = async function (req, res) {
  if (req.body.password == req.config.password) {
    res.cookie("autotoken", await getToken(req.headers.host));
    res.redirect('/');
  } else {
    res.redirect(LOGIN_PATH_URL);
  }
};
  
const logout = function (req, res) {
    res.clearCookie("autotoken");
    res.redirect(LOGIN_PATH_URL);
};

const checkPassword = async function (req, res, next) {
  if (req.method == "POST" && req.path == "/") {
    next();
    return;
  }

  if (req.config.password) {
    try 
    {
      var token = req.cookies.autotoken;
      if (token == undefined) {          
        if (req.path != LOGIN_PATH_URL) {
          res.redirect(LOGIN_PATH_URL);
        }
        next();
        return;
      }
      await verifyToken(token, req.headers.host);
    } 
    catch (err)
    {
      console.error(err);      
      if (req.path != LOGIN_PATH_URL) {
        res.redirect(LOGIN_PATH_URL);
      }
    }
  }    
  next();
};  

async function init(app, http) {
  // On startup, check to see if we have a config
  // document in config collection in the database. If we do not,
  // read the local config.yaml and create one.
  let config = await checkConfig();
  await authInit(config);

  // Need cookies for authentication
  app.use(cookieParser());
  
  // Register logger middleware
  app.use(expressWinston.logger({
    ...LOGGER_OPTIONS,
    format: winston.format.combine(
      winston.format.timestamp({
        format: 'YYYY-MM-DD HH:mm:ss'
      }),
      winston.format.colorize(),
      winston.format.json(),
      winston.format.printf(info => `${info.timestamp} ${info.level}: ${info.message} | request_body: ${JSON.stringify(info.meta.req.body)} | response_status_code: ${info.meta.res.statusCode} | response_body: ${JSON.stringify(info.meta.res.body)}`)
    ),
    requestWhitelist: ['headers', 'query', 'body'],
    responseWhitelist: ['body', 'statusCode', 'headers'],
    meta: true,
    msg: `method: {{req.method}} | host: {{req.headers.host}} | path: {{req.url}} | response_time: {{res.responseTime}}ms `, 
    expressFormat: false,
    colorize: false,
    ignoreRoute: function (req, res) { return false; }
  }));

  app.use(expressWinston.errorLogger({
    ...LOGGER_OPTIONS,
    format: winston.format.combine(
      winston.format.timestamp({
        format: 'YYYY-MM-DD HH:mm:ss'
      }),
      winston.format.colorize(),
      winston.format.json(),
      winston.format.printf(info => `${info.timestamp} ${info.level}: ${info.message} | request_body: ${JSON.stringify(info.meta.req.body)} | response_status_code: ${info.meta.res.statusCode} | response_body: ${JSON.stringify(info.meta.res.body)}`)
    ),
    requestWhitelist: ['headers', 'query', 'body'],
    responseWhitelist: ['body', 'statusCode', 'headers'],
    meta: true, 
    msg: `method: {{req.method}} | host: {{req.headers.host}} | path: {{req.url}} | response_time: {{res.responseTime}}ms `, 
    expressFormat: true,
    colorize: false,
    ignoreRoute: function (req, res) { return false; }
  }));

  // Register configuration middleware
  app.use(configMiddleware);

  // Register SDK routes in the web server
  app.use(checkPassword);
  app.get(LOGIN_PATH_URL, loginPage);
  app.post(LOGIN_PATH_URL, loginValidate);
  app.get(LOGOUT_PATH_URL, logout);
      
  app.post('/config', updateConfig);
  app.get('/config', getConfig);
  app.get('/config.json', getConfigJson);
  app.get('/config/clear/:collection', clearCollection);
  app.get('/metadata.json', getMetaData);
  app.post('/config.json', updateConfigJson);
};


module.exports = {
  init: init,
  getClient: getClient,
  DBName: DBName
}

/*
module.exports.init = init;
module.exports.getClient = getClient;
module.exports.DBName = DBName;
*/
