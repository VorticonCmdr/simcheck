(function() {
  var template = Handlebars.template, templates = Handlebars.templates = Handlebars.templates || {};
templates['coloring'] = template({"1":function(container,depth0,helpers,partials,data) {
    var helper, alias1=container.lambda, alias2=container.escapeExpression, lookupProperty = container.lookupProperty || function(parent, propertyName) {
        if (Object.prototype.hasOwnProperty.call(parent, propertyName)) {
          return parent[propertyName];
        }
        return undefined
    };

  return "<li class=\"list-group-item px-0 py-0 border border-0\">\n    <div class=\"input-group\">\n        <input type=\"text\" class=\"form-control bg-body w-25\" value=\""
    + alias2(alias1((depth0 != null ? lookupProperty(depth0,"regex") : depth0), depth0))
    + "\" disabled=\"\">\n        <input type=\"text\" class=\"form-control bg-body w-25\" value=\""
    + alias2(alias1((depth0 != null ? lookupProperty(depth0,"attr") : depth0), depth0))
    + "\" disabled=\"\">\n        <input type=\"color\" class=\"form-control-color\" value=\""
    + alias2(alias1((depth0 != null ? lookupProperty(depth0,"color") : depth0), depth0))
    + "\" disabled=\"\">\n        <button class=\"btn btn-outline-secondary removeColor\" type=\"button\" data-index=\""
    + alias2(((helper = (helper = lookupProperty(helpers,"index") || (data && lookupProperty(data,"index"))) != null ? helper : container.hooks.helperMissing),(typeof helper === "function" ? helper.call(depth0 != null ? depth0 : (container.nullContext || {}),{"name":"index","hash":{},"data":data,"loc":{"start":{"line":7,"column":88},"end":{"line":7,"column":98}}}) : helper)))
    + "\" data-regex=\""
    + alias2(alias1((depth0 != null ? lookupProperty(depth0,"regex") : depth0), depth0))
    + "\" data-attr=\""
    + alias2(alias1((depth0 != null ? lookupProperty(depth0,"attr") : depth0), depth0))
    + "\" data-color=\""
    + alias2(alias1((depth0 != null ? lookupProperty(depth0,"color") : depth0), depth0))
    + "\"><i class=\"bi bi-x-lg\"></i></button>\n    </div>\n</li>\n";
},"compiler":[8,">= 4.3.0"],"main":function(container,depth0,helpers,partials,data) {
    var stack1, lookupProperty = container.lookupProperty || function(parent, propertyName) {
        if (Object.prototype.hasOwnProperty.call(parent, propertyName)) {
          return parent[propertyName];
        }
        return undefined
    };

  return ((stack1 = lookupProperty(helpers,"each").call(depth0 != null ? depth0 : (container.nullContext || {}),depth0,{"name":"each","hash":{},"fn":container.program(1, data, 0),"inverse":container.noop,"data":data,"loc":{"start":{"line":1,"column":0},"end":{"line":10,"column":9}}})) != null ? stack1 : "");
},"useData":true});
})();