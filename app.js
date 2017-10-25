require('marko/node-require').install();
require('marko/express');
var express = require('express'),
    path = require('path'),
    favicon = require('serve-favicon'),
    logger = require('morgan'),
    compression = require('compression'),
    cookieParser = require('cookie-parser'),
    bodyParser = require('body-parser'),
    stylus = require('stylus'),
    routes = require('./routes/middleware'),
    prod = process.env.NODE_ENV === 'production',
    app = express();
app.disable('x-powered-by');

app.use(compression()); //compress the site

require('lasso').configure({
    plugins: ['lasso-marko'],
    outputDir: __dirname + '/dev/lasso',
    minify: prod,
    fingerprintsEnabled: false,
});
app.use(require('lasso/middleware').serveStatic());
app.use(favicon(path.join(__dirname, 'public', 'favicon.ico')));
app.use(logger('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(cookieParser());

function compile(str, path) {
   return stylus(str)
     .set('filename', path)
     .set('compress', prod);
 }
app.use(stylus.middleware({
  src: path.join(__dirname, 'dev'),
  dest: path.join(__dirname, 'public'),
  'include css': true,
  debug: true,
  compile: compile
}));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/', routes);
module.exports = app;
