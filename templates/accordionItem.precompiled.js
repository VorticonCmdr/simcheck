(function() {
  var template = Handlebars.template, templates = Handlebars.templates = Handlebars.templates || {};
templates['accordionItem'] = template({"1":function(container,depth0,helpers,partials,data) {
    var stack1, helper, alias1=depth0 != null ? depth0 : (container.nullContext || {}), alias2=container.hooks.helperMissing, alias3="function", alias4=container.escapeExpression, alias5=container.lambda, lookupProperty = container.lookupProperty || function(parent, propertyName) {
        if (Object.prototype.hasOwnProperty.call(parent, propertyName)) {
          return parent[propertyName];
        }
        return undefined
    };

  return "<div class=\"accordion-item\">\n    <h2 class=\"accordion-header\" id=\"heading"
    + alias4(((helper = (helper = lookupProperty(helpers,"index") || (data && lookupProperty(data,"index"))) != null ? helper : alias2),(typeof helper === alias3 ? helper.call(alias1,{"name":"index","hash":{},"data":data,"loc":{"start":{"line":3,"column":44},"end":{"line":3,"column":54}}}) : helper)))
    + "\">\n        <button class=\"accordion-button collapsed "
    + ((stack1 = lookupProperty(helpers,"if").call(alias1,(depth0 != null ? lookupProperty(depth0,"clicked") : depth0),{"name":"if","hash":{},"fn":container.program(2, data, 0),"inverse":container.noop,"data":data,"loc":{"start":{"line":4,"column":50},"end":{"line":4,"column":94}}})) != null ? stack1 : "")
    + "\" type=\"button\" data-bs-toggle=\"collapse\" data-bs-target=\"#collapse"
    + alias4(((helper = (helper = lookupProperty(helpers,"index") || (data && lookupProperty(data,"index"))) != null ? helper : alias2),(typeof helper === alias3 ? helper.call(alias1,{"name":"index","hash":{},"data":data,"loc":{"start":{"line":4,"column":161},"end":{"line":4,"column":171}}}) : helper)))
    + "\">\n        "
    + alias4(alias5((depth0 != null ? lookupProperty(depth0,"title") : depth0), depth0))
    + "\n        </button>\n    </h2>\n    <div id=\"collapse"
    + alias4(((helper = (helper = lookupProperty(helpers,"index") || (data && lookupProperty(data,"index"))) != null ? helper : alias2),(typeof helper === alias3 ? helper.call(alias1,{"name":"index","hash":{},"data":data,"loc":{"start":{"line":8,"column":21},"end":{"line":8,"column":31}}}) : helper)))
    + "\" class=\"accordion-collapse collapse "
    + ((stack1 = lookupProperty(helpers,"if").call(alias1,(depth0 != null ? lookupProperty(depth0,"clicked") : depth0),{"name":"if","hash":{},"fn":container.program(4, data, 0),"inverse":container.noop,"data":data,"loc":{"start":{"line":8,"column":68},"end":{"line":8,"column":99}}})) != null ? stack1 : "")
    + "\" data-bs-parent=\"#accordionRelated\">\n        <div class=\"accordion-body\">\n            <h5 class=\"card-title\"><a href=\""
    + ((stack1 = alias5((depth0 != null ? lookupProperty(depth0,"id") : depth0), depth0)) != null ? stack1 : "")
    + "/\" target=\"_blank\">"
    + alias4(alias5((depth0 != null ? lookupProperty(depth0,"title") : depth0), depth0))
    + "</a></h5>\n            <p class=\"small card-subtitle mb-2 text-muted\">"
    + alias4(alias5((depth0 != null ? lookupProperty(depth0,"description") : depth0), depth0))
    + "</p>\n        </div>\n    </div>\n</div>\n";
},"2":function(container,depth0,helpers,partials,data) {
    return "bg-success-subtle";
},"4":function(container,depth0,helpers,partials,data) {
    return "show";
},"compiler":[8,">= 4.3.0"],"main":function(container,depth0,helpers,partials,data) {
    var stack1, lookupProperty = container.lookupProperty || function(parent, propertyName) {
        if (Object.prototype.hasOwnProperty.call(parent, propertyName)) {
          return parent[propertyName];
        }
        return undefined
    };

  return ((stack1 = lookupProperty(helpers,"each").call(depth0 != null ? depth0 : (container.nullContext || {}),depth0,{"name":"each","hash":{},"fn":container.program(1, data, 0),"inverse":container.noop,"data":data,"loc":{"start":{"line":1,"column":0},"end":{"line":15,"column":9}}})) != null ? stack1 : "");
},"useData":true});
})();