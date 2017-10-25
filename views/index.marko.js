// Compiled using marko@4.5.3 - DO NOT EDIT
"use strict";

var marko_template = module.exports = require("marko/src/html").t(__filename),
    components_helpers = require("marko/src/components/helpers"),
    marko_registerComponent = components_helpers.rc,
    marko_componentType = marko_registerComponent("/marko-express-starter$0.0.0/views/index.marko", function() {
      return module.exports;
    }),
    marko_renderer = components_helpers.r,
    marko_defineComponent = components_helpers.c,
    marko_loadTemplate = require("marko/src/runtime/helper-loadTemplate"),
    layout_template = marko_loadTemplate(require.resolve("./layout.marko")),
    marko_helpers = require("marko/src/runtime/html/helpers"),
    marko_escapeXml = marko_helpers.x,
    cout_template = marko_loadTemplate(require.resolve("./components/cout")),
    marko_loadTag = marko_helpers.t,
    cout_tag = marko_loadTag(cout_template),
    hasRenderBodyKey = Symbol.for("hasRenderBody"),
    include_tag = marko_loadTag(require("marko/src/taglibs/core/include-tag"));

function render(input, out, __component, component, state) {
  var data = input;

  include_tag({
      _target: layout_template,
      title: input.title,
      body: {
          renderBody: function renderBody(out) {
            out.w("<h1>This name came from your route index.js: " +
              marko_escapeXml(input.name) +
              "</h1><p>The nex line has the same name input but the value changes from your view index.marko</p>");

            cout_tag({
                name: "world!"
              }, out, __component, "4");
          }
        },
      [hasRenderBodyKey]: true
    }, out, __component, "0");
}

marko_template._ = marko_renderer(render, {
    ___implicit: true,
    ___type: marko_componentType
  });

marko_template.Component = marko_defineComponent({}, marko_template._);

marko_template.meta = {
    tags: [
      "./layout.marko",
      "./components/cout",
      "marko/src/taglibs/core/include-tag"
    ]
  };
