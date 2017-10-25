var express = require('express'),
    router = express.Router(),
    template = require('../views/index.marko');

router.get('/', function(req, res) {
    res.marko(template, {
        title: 'MarkoTitle',
        name: 'Bill',
        count: 30,
        colors: ['red', 'green', 'blue']
    });
});

// catch 404 and forward to error handler
router.use(function(req, res, next) {
  var err = new Error('Not Found');
  err.status = 404;
  next(err);
});

// error handler
router.use(function(err, req, res, next) {//eslint-disable-line
  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};
  // render the error page
  res.status(err.status || 500);
  res.send("Error Page Not Found");
});

module.exports = router;
