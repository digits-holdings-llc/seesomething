const { JWT, JWK } = require('jose');
const key = JWK.asKey({
    kty: 'oct',
    k: 'hJtXIZ2uSN5kbQfbtTNWbpdmhkV8FJG-Onbc6mxCcYg'
});

var payload;



async function init(config) {
    payload = {
        'urn:automations:id' : config.unique_id
    };
}

async function getToken(host) {
    return JWT.sign(payload, key, {
        audience: ['urn:automations:id'],
        issuer: host,
        expiresIn: '2 hours',
        header: {
            typ: 'JWT'
        }
    });
}

async function verifyToken(token, host) {
    return JWT.verify(token, key, {
        audience: 'urn:automations:id',
        issuer: host,
        clockTolerance: '1 min'
      });
}


module.exports.authInit = init;
module.exports.getToken = getToken;
module.exports.verifyToken = verifyToken;