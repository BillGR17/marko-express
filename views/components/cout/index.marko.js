// Compiled using marko@4.5.3 - DO NOT EDIT
"use strict";

var marko_template = module.exports = require("marko/src/html").t(__filename),
    marko_component = {
        onCreate: function() {
          this.state = {
              count: 0
            };
        },
        onMount: function() {
          console.log("Mounted in the browser!");

          var a = name;

          console.log(a);
        },
        increment: function() {
          this.state.count++;
        }
      },
    components_helpers = require("marko/src/components/helpers"),
    marko_registerComponent = components_helpers.rc,
    marko_componentType = marko_registerComponent("/marko-express-starter$0.0.0/views/components/cout/index.marko", function() {
      return module.exports;
    }),
    marko_renderer = components_helpers.r,
    marko_defineComponent = components_helpers.c,
    marko_helpers = require("marko/src/runtime/html/helpers"),
    marko_escapeXml = marko_helpers.x,
    marko_attr = marko_helpers.a;

function render(input, out, __component, component, state) {
  var data = input;

  out.w("<p>Hello " +
    marko_escapeXml(input.name) +
    "</p><p>All of this is imported from the componets</p><div class=\"count\">" +
    marko_escapeXml(state.count) +
    "</div><button type=\"button\"" +
    marko_attr("data-marko", {
      onclick: __component.d("increment")
    }, false) +
    ">Click me</button>");
}

marko_template._ = marko_renderer(render, {
    ___type: marko_componentType
  }, marko_component);

marko_template.Component = marko_defineComponent(marko_component, marko_template._);

marko_template.meta = {
    deps: [
      {
          type: "css",
          code: ".count {\n        color:#09c;\n        font-size:3em;\n    }\n    .example-button {\n        font-size:1em;\n        padding:0.5em;\n    }",
          virtualPath: "./index.marko.css",
          path: "./index.marko"
        },
      {
          type: "require",
          path: "./"
        }
    ]
  };
