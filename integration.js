'use strict';

const request = require('request');
const config = require('./config/config');
const async = require('async');
const fs = require('fs');

let Logger;
let requestWithDefaults;

const MAX_PARALLEL_LOOKUPS = 10;

function startup(logger) {
  let defaults = {};
  Logger = logger;

  const { cert, key, passphrase, ca, proxy, rejectUnauthorized } = config.request;

  if (typeof cert === 'string' && cert.length > 0) {
    defaults.cert = fs.readFileSync(cert);
  }

  if (typeof key === 'string' && key.length > 0) {
    defaults.key = fs.readFileSync(key);
  }

  if (typeof passphrase === 'string' && passphrase.length > 0) {
    defaults.passphrase = passphrase;
  }

  if (typeof ca === 'string' && ca.length > 0) {
    defaults.ca = fs.readFileSync(ca);
  }

  if (typeof proxy === 'string' && proxy.length > 0) {
    defaults.proxy = proxy;
  }

  if (typeof rejectUnauthorized === 'boolean') {
    defaults.rejectUnauthorized = rejectUnauthorized;
  }

  requestWithDefaults = request.defaults(defaults);
}

function doLookup(entities, options, cb) {
  let lookupResults = [];
  let tasks = [];

  Logger.debug(entities);
  entities.forEach((entity) => {
    let requestOptions = {
      method: 'POST',
      auth: {
        user: options.apiUser,
        pass: options.apiPass
      },
      uri: `${options.url}/apiv1/threat/search`,
      json: true
    };

    if (entity.isHash) {
      requestOptions.qs = {
        allHash: `${entity.value}`
      };
    } else if (entity.isIPv4) {
      requestOptions.qs = {
        ip: `${entity.value}`
      };
    } else if (entity.isDomain) {
      requestOptions.qs = {
        domain: `${entity.value}`
      };
    } else {
      return;
    }

    Logger.trace({ requestOptions }, 'Request Options');

    tasks.push(function (done) {
      requestWithDefaults(requestOptions, function (error, res, body) {
        Logger.trace({ body, status: res.statusCode });
        let processedResult = handleRestError(error, entity, res, body);

        if (processedResult.error) {
          done(processedResult);
          return;
        }

        done(null, processedResult);
      });
    });
  });

  async.parallelLimit(tasks, MAX_PARALLEL_LOOKUPS, (err, results) => {
    if (err) {
      Logger.error({ err: err }, 'Error');
      cb(err);
      return;
    }

    results.forEach((result) => {
      if (result.body === null || result.body.length === 0 || result.body.data.page.totalElements === 0) {
        lookupResults.push({
          entity: result.entity,
          data: null
        });
      } else {
        lookupResults.push({
          entity: result.entity,
          data: {
            summary: getTags(result.body),
            details: result.body
          }
        });
      }
    });

    Logger.debug({ lookupResults }, 'Results');
    cb(null, lookupResults);
  });
}

function getTags(results) {
  let tags = [];

  if (results.data && results.data.page && results.data.page.totalElements) {
    tags.push(`Total Results: ${results.data.page.totalElements}`);
  }

  if (results.data && Array.isArray(results.data.threats)) {
    results.data.threats.forEach((threat) => {
      tags.push(`Threat Type: ${threat.threatType}`);
    });
  }

  if (tags.length === 0) {
    tags.push('No Summary Tags');
  }
  return tags;
}

function handleRestError(error, entity, res, body) {
  let result;

  if (error) {
    return {
      error: error,
      detail: 'HTTP Request Error'
    };
  }

  if (res.statusCode === 200 && body) {
    // we got data!
    result = {
      entity: entity,
      body: body
    };
  } else if (res.statusCode === 400) {
    result = {
      error: 'Bad Request',
      detail: 'Request was invalid'
    };
  } else if (res.statusCode === 401) {
    result = {
      error: 'Unauthorized',
      detail: 'Unauthorized, please check your credentials'
    };
  } else if (res.statusCode === 404) {
    result = {
      error: 'Not Found',
      detail: 'Query resulted in not found'
    };
  } else {
    result = {
      error: body,
      statusCode: res ? res.statusCode : 'Unknown',
      detail: 'An unexpected error occurred'
    };
  }

  return result;
}

function validateOption(errors, options, optionName, errMessage) {
  if (
    typeof options[optionName].value !== 'string' ||
    (typeof options[optionName].value === 'string' && options[optionName].value.length === 0)
  ) {
    errors.push({
      key: optionName,
      message: errMessage
    });
  }
}

function validateOptions(options, callback) {
  let errors = [];

  validateOption(errors, options, 'url', 'You must provide a valid URL.');
  validateOption(errors, options, 'apiUser', 'You must provide a valid API username.');
  validateOption(errors, options, 'apiPass', 'You must provide a valid API password.');

  callback(null, errors);
}

module.exports = {
  doLookup: doLookup,
  validateOptions: validateOptions,
  startup: startup
};
