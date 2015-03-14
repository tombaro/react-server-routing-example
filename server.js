var http = require('http'),
    browserify = require('browserify'),
    literalify = require('literalify'),
    React = require('react'),
    AWS = require('aws-sdk'),
    // Our routes, DB and React components are all shared by server and browser
    // thanks to browserify
    routes = require('./routes'),
    db = require('./db'),
    App = React.createFactory(require('./App')),
    DOM = React.DOM, body = DOM.body, div = DOM.div, script = DOM.script


// Just create a plain old HTTP server that responds to our route endpoints
// (and '/bundle.js')
var server = http.createServer(function(req, res) {

  // See if we have any component routes matching the requested URL
  var route = routes.resolve(req.url)

  if (route) {

    res.setHeader('Content-Type', 'text/html')

    // We have a matching route, so call its data-fetching function to get the
    // props/data we'll need to pass to the top-level component
    route.fetchData(function(err, data) {

      if (err) {
        res.statusCode = err.message == 'NotFound' ? 404 : 500
        return res.end(err.toString())
      }

      // Define the props for the top level React component – here we have the
      // name of the component we want to display for this route, as well as
      // any data we've fetched
      var props = {
        componentName: route.componentName,
        data: data,
      }

      // Here we're using React to render the outer body, so we just use the
      // simpler renderToStaticMarkup function, but you could use any templating
      // language (or just a string) for the outer page template
      var html = React.renderToStaticMarkup(body(null,

        // The actual server-side rendering of our component occurs here,
        // passing in `props`. This div is the same one that the client will
        // "render" into on the browser from browser.js
        div({id: 'content', dangerouslySetInnerHTML: {__html:
          React.renderToString(App(props))
        }}),

        // The props should match on the client and server, so we stringify them
        // on the page to be available for access by the code run in browser.js
        // You could use any var name here as long as it's unique
        script({dangerouslySetInnerHTML: {__html:
          'var APP_PROPS = ' + safeStringify(props) + ';'
        }}),

        // We'll load React and AWS from a CDN - you don't have to do this,
        // you can bundle them up or serve them locally if you like
        script({src: '//fb.me/react-0.13.0.min.js'}),
        script({src: '//sdk.amazonaws.com/js/aws-sdk-2.1.17.min.js'}),

        // Then the browser will fetch and run the browserified bundle consisting
        // of browser.js and all its dependencies.
        // We serve this from the endpoint a few lines down.
        script({src: '/bundle.js'})
      ))

      // Return the page to the browser
      res.end(html)
    })

  // This endpoint is hit when the browser is requesting bundle.js from the page above
  } else if (req.url == '/bundle.js') {

    res.setHeader('Content-Type', 'text/javascript')

    // Here we invoke browserify to package up browser.js and everything it requires.
    // DON'T do it on the fly like this in production - it's very costly -
    // either compile the bundle ahead of time, or use some smarter middleware
    // (eg browserify-middleware).
    // We also use literalify to transform our `require` statements for React
    // and AWS so that it uses the global variable (from the CDN JS file)
    // instead of bundling it up with everything else
    return browserify()
      .add('./browser.js')
      .transform(literalify.configure({
        'react': 'window.React',
        'aws-sdk': 'window.AWS',
      }))
      .bundle()
      .pipe(res)

  // Return 404 for all other requests
  } else {
    res.statusCode = 404
    return res.end('Not Found')
  }

})

// We start the http server on after we check if the DB has been setup correctly
ensureTableExists(function(err) {
  if (err) throw err
  server.listen(3000, function(err) {
    if (err) throw err
    console.log('Listening on 3000...')
  })
})


// A utility function to safely escape JSON for embedding in a <script> tag
function safeStringify(obj) {
  return JSON.stringify(obj).replace(/<\/script/g, '<\\/script').replace(/<!--/g, '<\\!--')
}


// A bootstrapping function to create and populate our DB table if it doesn't
// exist (and start the mock DB if running locally)
function ensureTableExists(cb) {

  var posts = [{
    id: {S: '123'},
    date: {S: '2015-01-01'},
    title: {S: 'That\'s not a knife'},
    body: {S: 'This is a knife'},
  }, {
    id: {S: '345'},
    date: {S: '2015-01-02'},
    title: {S: 'A dingo stole my baby\'s...'},
    body: {S: '... heart. She\'s really in love with it :-('},
  }]

  if (db.endpoint.hostname == 'localhost') {
    console.log('Starting local dynalite server...')

    require('dynalite')({path: './grumblr'}).listen(db.endpoint.port, describeTable)
  } else {
    describeTable()
  }

  function describeTable(err) {
    if (err) return cb(err)

    console.log('Checking DB for table...')

    db.describeTable({TableName: 'grumblr'}, createTable)
  }

  function createTable(err) {
    if (!err) return cb()

    if (err.code != 'ResourceNotFoundException') return cb(err)

    console.log('Creating DB table (may take a while)...')

    db.createTable({
      TableName: 'grumblr',
      KeySchema: [{AttributeName: 'id', KeyType: 'HASH'}],
      AttributeDefinitions: [{AttributeName: 'id', AttributeType: 'S'}],
      ProvisionedThroughput: {ReadCapacityUnits: 1, WriteCapacityUnits: 1},
    }, waitForTable)
  }

  function waitForTable(err) {
    if (err) return cb(err)

    var waiter = new AWS.ResourceWaiter(db, 'tableExists')
    waiter.config.interval = 1
    waiter.wait({TableName: 'grumblr'}, writePosts)
  }

  function writePosts(err) {
    if (err) return cb(err)

    db.batchWriteItem({
      RequestItems: {
        grumblr: posts.map(function(item) { return {PutRequest: {Item: item}} })
      }
    }, cb)
  }
}