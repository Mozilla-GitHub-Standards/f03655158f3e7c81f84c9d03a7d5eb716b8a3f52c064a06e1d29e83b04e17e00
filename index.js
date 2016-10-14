'use strict';

// See https://tools.ietf.org/html/draft-ietf-acme-acme-01
// also https://gitlab.com/pushrocks/cert/blob/master/ts/cert.hook.ts

var PromiseA = require('bluebird');
var dns = PromiseA.promisifyAll(require('dns'));
var DDNS = require('ddns-cli');

//var count = 0;
var defaults = {
  oauth3: 'oauth3.org'
, debug: false
, acmeChallengeDns: '_acme-challenge.' // _acme-challenge.example.com TXT xxxxxxxxxxxxxxxx
, memstoreConfig: {
    name: 'le-ddns'
  }
};

var Challenge = module.exports;

Challenge.create = function (options) {
  // count += 1;
  var store = require('cluster-store');
  var results = {};

  Object.keys(Challenge).forEach(function (key) {
    results[key] = Challenge[key];
  });
  results.create = undefined;

  Object.keys(defaults).forEach(function (key) {
    if (!(key in options)) {
      options[key] = defaults[key];
    }
  });
  results._options = options;

  results.getOptions = function () {
    return results._options;
  };

  // TODO fix race condition at startup
  results._memstore = options.memstore;

  if (!results._memstore) {
    store.create(options.memstoreConfig).then(function (store) {
      // same api as new sqlite3.Database(options.filename)

      results._memstore = store;

      // app.use(expressSession({ secret: 'keyboard cat', store: store }));
    });
  }

  return results;
};

//
// NOTE: the "args" here in `set()` are NOT accessible to `get()` and `remove()`
// They are provided so that you can store them in an implementation-specific way
// if you need access to them.
//
Challenge.set = function (args, domain, challenge, keyAuthorization, done) {
  var me = this;
  // TODO use base64url module
  var keyAuthDigest = require('crypto').createHash('sha256').update(keyAuthorization||'').digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
    ;

  if (!challenge || !keyAuthorization) {
    console.warn("SANITY FAIL: missing challenge or keyAuthorization", domain, challenge, keyAuthorization);
  }

  return me._memstore.set(domain, {
    email: args.email
  , refreshToken: args.refreshToken
  , keyAuthDigest: keyAuthDigest
  }, function (err) {
    if (err) { done(err); return; }

    var challengeDomain = (args.test || '') + args.acmeChallengeDns + domain;
    var update = {
      email: args.email
    , refreshToken: args.refreshToken
    , silent: true

    , name: challengeDomain
    , type: "TXT"
    , value: keyAuthDigest || challenge
    , ttl: args.ttl || 0
    };

    return DDNS.update(update, {
      //debug: true
    }).then(function () {
      if (args.debug) {
        console.log("Test DNS Record:");
        console.log("dig TXT +noall +answer @ns1.redirect-www.org '" + challengeDomain + "' # " + challenge);
      }
      done(null, keyAuthDigest);
    }, function (err) {
      console.error(err);
      done(err);
      return PromiseA.reject(err);
    });
  });
};


//
// NOTE: the "defaults" here are still merged and templated, just like "args" would be,
// but if you specifically need "args" you must retrieve them from some storage mechanism
// based on domain and key
//
Challenge.get = function (defaults, domain, challenge, done) {
  done = null; // nix linter error for unused vars
  throw new Error("Challenge.get() does not need an implementation for dns-01. (did you mean Challenge.loopback?)");
};

Challenge.remove = function (defaults, domain, challenge, done) {
  var me = this;

  return me._memstore.get(domain, function (err, data) {
    if (err) { done(err); return; }
    if (!data) {
      console.warn("[warning] could not remove '" + domain + "': already removed");
      done(null);
      return;
    }

    var challengeDomain = (defaults.test || '') + defaults.acmeChallengeDns + domain;

    return DDNS.update({
      email: data.email
    , refreshToken: data.refreshToken
    , silent: true

    , name: challengeDomain
    , type: "TXT"
    , value: data.keyAuthDigest || challenge
    , ttl: defaults.ttl || 0

    , remove: true
    }, {
      //debug: true
    }).then(function () {

      done(null);
    }, done).then(function () {
      me._memstore.destroy(domain);
    });
  });
};

// same as get, but external
Challenge.loopback = function (defaults, domain, challenge, done) {
  var challengeDomain = (defaults.test || '') + defaults.acmeChallengeDns + domain;
  dns.resolveTxtAsync(challengeDomain).then(function (x) { done(null, x); }, done);
};

Challenge.test = function (args, domain, challenge, keyAuthorization, done) {
  var me = this;

  args.test = args.test || '_test.';
  defaults.test = args.test;

  me.set(args, domain, challenge, keyAuthorization || challenge, function (err, k) {
    if (err) { done(err); return; }

    me.loopback(defaults, domain, challenge, function (err, arr) {
      if (err) { done(err); return; }

      if (!arr.some(function (a) {
        return a.some(function (keyAuthDigest) {
          return keyAuthDigest === k;
        });
      })) {
        err = new Error("txt record '" + challenge + "' doesn't match '" + k + "'");
      }

      me.remove(defaults, domain, challenge, function (_err) {
        if (_err) { done(_err); return; }

        // TODO needs to use native-dns so that specific nameservers can be used
        // (otherwise the cache will still have the old answer)
        done(err || null);
        /*
        me.loopback(defaults, domain, challenge, function (err) {
          if (err) { done(err); return; }

          done();
        });
        */
      });
    });
  });
};
