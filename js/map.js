import { settings, initializeSettings } from "/js/settings.js";

import "/libs/d3.min.v7.9.0.js";
import { firstEntry, openDatabase } from "/js/indexeddb.js";

const $menuOffcanvas = new bootstrap.Offcanvas("#offcanvasMenu");
const $bsOffcanvas = new bootstrap.Offcanvas("#offcanvasRight");
const $offcanvasRightElement = document.getElementById("offcanvasRight");
const $clusterSelect = $("#clusterSelect");

let mapData = {};

let board = {
  mapsData: [],
  cluster_centers: [],
  coordinates: [],
  selectedCircles: [],
  sums: [],
  width: $("#board").width(),
  height: $("#board").height(),
  activeBrush: false,
  activeTooltip: false,
  margin: {
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
  },
};

let config = {
  colors: {
    default: "#a9a9a9", //"rgb(13 110 253)",
  },
  opacity: {
    default: 0.8,
    selected: 1.0,
    unselected: 0.3,
  },
  dbscan: {
    minPts: 3,
    eps: 0.3,
  },
  fields: {
    disabled: new Set(["embeddings", "clusterNumber", "order", "coordinates"]),
    available: new Set(),
  },
  regexes: [],
  labels: {
    title: "H1-1",
    description: "Meta Description 1",
  },
};

async function loadMapData(db, tableName) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([tableName], "readonly");
    const objectStore = transaction.objectStore(tableName);
    settings.indexedDB.keyPath = objectStore.keyPath;
    const request = objectStore.openCursor();

    request.onsuccess = (event) => {
      const cursor = event.target.result;

      function processCursor(cursor) {
        if (cursor) {
          let doc = cursor.value;
          Object.keys(doc).forEach((key) => config.fields.available.add(key));
          mapData[doc[settings.indexedDB.keyPath]] = doc;
          cursor.continue();
        } else {
          //resolve(event.target.result);
          resolve(true);
        }
      }

      processCursor(cursor);
    };

    request.onerror = (event) => {
      //reject(event.target.error);
      resolve(false);
    };
  });
}

function setupSelects() {
  let html = [...config.fields.available]
    .filter((name) => {
      return !config.fields.disabled.has(name);
    })
    .reduce((accumulator, currentValue) => {
      return `${accumulator}\n<option value="${currentValue}">${currentValue}</option>`;
    }, ``);
  $("#colorFields").html(html);
  $("#titleSelect").html(html);
  $("#titleSelect").val(config.labels.title);
  $("#descriptionSelect").html(html);
  $("#descriptionSelect").val(config.labels.description);
}

async function loadData(objectStoreName) {
  mapData = {};
  let db = await openDatabase(settings.indexedDB, true);

  let loaded = await loadMapData(db, settings.indexedDB.tableName);
  setupSelects();

  db.close();
  return loaded;
}

function handleZoom(e) {
  d3.selectAll(".datalayer").attr("transform", e.transform);
}

function resetZoom() {
  d3.selectAll(".datalayer").transition().call(board["zoom"].scaleTo, 1);

  d3.selectAll(".datalayer")
    .transition()
    .call(board["zoom"].translateTo, 0.5 * board.width, 0.5 * board.height);
}

function brushed({ selection }) {
  if (selection === null) {
    board["circles"].attr("stroke", null);
  } else {
    let tx = d3.zoomTransform(board.svg.select("#circles")["_groups"][0][0]);
    let [[x0, y0], [x1, y1]] = selection;
    board.selectedCircles = [];
    board["circles"].each(function (d, i) {
      let elem = d3.select(this);
      let cx = tx.x + elem.attr("cx") * tx.k;
      let cy = tx.y + elem.attr("cy") * tx.k;
      if (x0 <= cx && cx <= x1 && y0 <= cy && cy <= y1) {
        elem.attr("stroke", "red");
        board.selectedCircles.push(elem.data()[0]);
      } else {
        elem.attr("stroke", null);
      }
    });
    if (board.selectedCircles.length > 0) {
      let html = accordionTemplate({
        hits: board.selectedCircles,
      });
      $("#accordionRelated").html(html);
      $bsOffcanvas.show();
    }
  }
}

function generateColors(numColors) {
  const colors = [];
  const hueStep = 360 / numColors; // Divide the color wheel into equal parts

  for (let i = 0; i < numColors; i++) {
    const hue = i * hueStep;
    colors.push(`hsl(${hue}, 100%, 50%)`); // Saturation: 100%, Lightness: 50%
  }

  return colors;
}
function colorClusters() {
  let colors = generateColors(board.cluster_centers.length);
  colors.forEach((color, i) => {
    board.circles
      .filter(function (d) {
        return d && d.cluster == i;
      })
      .attr("fill", color)
      .attr("opacity", config.opacity.default)
      .attr("r", 2);
  });
}

function colorCircles(pattern) {
  board.circles
    .filter(function (d) {
      return d && d?.[pattern.attr].match(pattern.regex);
    })
    .attr("fill", pattern.color)
    .attr("opacity", config.opacity.default)
    .attr("r", 2);
}

function colorByRegexes() {
  $("#coloring").empty();
  config.regexes.forEach((pattern) => {
    colorCircles(pattern);
  });
  let html = Handlebars.templates.coloring(config.regexes);
  $("#coloring").html(html);
}

// A function to check whether two bounding boxes do not overlap
const getOverlapFromTwoExtents = (l, r) => {
  var overlapPadding = 0;
  l.left = l.x - overlapPadding;
  l.right = l.x + l.width + overlapPadding;
  l.top = l.y - overlapPadding;
  l.bottom = l.y + l.height + overlapPadding;
  r.left = r.x - overlapPadding;
  r.right = r.x + r.width + overlapPadding;
  r.top = r.y - overlapPadding;
  r.bottom = r.y + r.height + overlapPadding;
  var a = l;
  var b = r;

  if (
    a.left >= b.right ||
    a.top >= b.bottom ||
    a.right <= b.left ||
    a.bottom <= b.top
  ) {
    return true;
  } else {
    return false;
  }
};

function sanitizeForQuerySelector(url) {
  // Define a regex to match valid characters for querySelector
  let validChars = /[a-zA-Z0-9_-]/g;

  // Filter the characters
  let sanitizedString = url.match(validChars).join("");

  return sanitizedString;
}

function centerNode(id) {
  let node = d3.select(`#${id}`);
  let cx = node.attr("cx");
  let cy = node.attr("cy");
  d3.selectAll(".datalayer")
    .transition()
    .duration(300)
    .attr(
      "transform",
      `translate(${0.5 * board.width - cx},${0.5 * board.height - cy})scale(2)`,
    )
    .on("end", function () {
      board.zoomer.call(
        board.zoom.transform,
        d3.zoomIdentity
          .translate(0.5 * board.width - cx * 2, 0.5 * board.height - cy * 2)
          .scale(2),
      );
    });
}

function showCluster(clickedCircle) {
  $("#offcanvasRightLabel").text("");
  $("#offcanvasRightLabel").text(clickedCircle.cluster);

  $("#accordionRelated").empty();

  let circles = board["circles"]
    .filter(function (circle) {
      if (circle.cluster == clickedCircle.cluster) {
        if (circle === clickedCircle) {
          circle.clicked = true;
        } else {
          circle.clicked = false;
        }
        return true;
      }
      return false;
    })
    .data();

  let items = circles.map((circle) => {
    return {
      title: circle[config.labels.title],
      description: circle[config.labels.description],
      id: circle[settings.indexedDB.keyPath],
      clicked: circle.clicked,
      color: circle.color,
    };
  });

  let html = Handlebars.templates.accordionItem(items);
  $("#accordionRelated").html(html);
  $bsOffcanvas.show();
}

function circleClick(pointerEvent, clickedCircle) {
  centerNode(pointerEvent.target.id);
  updateCircles(clickedCircle.cluster);
  showCluster(clickedCircle);
}

function updateCircles(selectedCluster) {
  board["circles"]
    .filter((d) => d.cluster == selectedCluster)
    .attr("opacity", config.opacity.selected)
    .attr("stroke", "red");

  board["circles"]
    .filter((d) => d.cluster != selectedCluster)
    .attr("opacity", config.opacity.unselected)
    .attr("stroke", null);
}

function resetState() {
  board["circles"].attr("opacity", config.opacity.default).attr("stroke", null);
}

async function generateMap() {
  if (board.svg) {
    board.svg.selectAll("*").remove();
  }

  $("#board").toggleClass("visible");
  $("#table").toggleClass("invisible");
  board.mapsData = Object.values(mapData);
  board.coordinates = board.mapsData.map((item) => {
    return {
      x: item.coordinates[0],
      y: item.coordinates[1],
    };
  });

  board["svg"] = d3
    .select("#map")
    .attr("height", board.height)
    .attr("width", board.width);

  board["zoom"] = d3.zoom().on("zoom", (event) => {
    svg.attr("transform", event.transform);
  });

  board["zoom"] = d3
    .zoom()
    //.filter(event => !activeBrush)
    .filter((event) => {
      return !board.activeBrush;
    })
    .on("zoom", handleZoom);

  // initZoom
  board["zoomer"] = d3.select("svg").call(board["zoom"]);

  board["xScale"] = d3
    .scaleLinear()
    .range([board.margin.left, board.width - board.margin.right])
    .domain(d3.extent(board.coordinates.map((d) => d.x)));

  board["yScale"] = d3
    .scaleLinear()
    .range([board.height - board.margin.bottom, board.margin.top])
    .domain(d3.extent(board.coordinates.map((d) => d.y)));

  board["labels"] = board.svg
    .append("g")
    .attr("id", "labels")
    .attr("class", "datalayer")
    .attr("font-size", 10)
    .selectAll("text")
    .data(board.mapsData)
    .join("text")
    .attr("id", (d) => {
      return `t${sanitizeForQuerySelector(d[settings.indexedDB.keyPath])}`;
    })
    .attr("dy", "0.35em")
    .attr("x", (d) => board.xScale(d.coordinates[0]) + 3)
    .attr("y", (d) => board.yScale(d.coordinates[1]))
    .attr("opacity", 0)
    .text((d) => d[config.labels.title]);

  board["brush"] = d3
    .brush()
    .filter((event) => {
      return board.activeBrush || event.target.__data__.type !== "overlay";
    })
    .on("end", brushed);

  board.svg
    .append("g")
    .attr("class", "brush")
    .call(board.brush)
    .call((g) => g.select(".overlay").style("cursor", "default"));

  const distance = (x1, y1, x2, y2) => Math.hypot(x2 - x1, y2 - y1);

  let dbscan = new DBSCAN();
  let clusters = dbscan.run(
    board.coordinates,
    config.dbscan.eps,
    config.dbscan.minPts,
  );

  board["cluster_centers"] = dbscan._getClusterCenters();
  dbscan._assigned.forEach((cluster, i) => {
    board.mapsData[i]["cluster"] = cluster;
  });

  board["setCentroids"] = [];
  board["cluster_centers"].forEach((cc, i) => {
    let minDist = 0xffff;
    cc.parts.forEach((ccp) => {
      let h = board.mapsData[ccp];
      let dist = distance(cc.x, cc.y, h.coordinates[0], h.coordinates[1]);
      if (dist < minDist) {
        minDist = dist;
        board.setCentroids[i] = h;
      }
    });
  });

  // append circles last to be on top
  board["circles"] = board.svg
    .append("g")
    .attr("id", "circles")
    .attr("class", "datalayer")
    .selectAll("circle")
    .data(board.mapsData)
    .join("circle")
    .attr("id", (d) => {
      return `c${sanitizeForQuerySelector(d[settings.indexedDB.keyPath])}`;
    })
    .attr("cx", (d) => board.xScale(d.coordinates[0]))
    .attr("cy", (d) => board.yScale(d.coordinates[1]))
    .attr("r", 2)
    .attr("fill", config.colors.default)
    .attr("opacity", config.opacity.default)
    .attr("data-bs-toggle", "tooltip")
    .attr("data-bs-title", (d) => d[config.labels.title])
    .on("click", circleClick);

  let tooltipTriggerList = document.querySelectorAll(
    '[data-bs-toggle="tooltip"]',
  );
  let tooltipList = [...tooltipTriggerList]
    .filter((tooltipTriggerEl) =>
      tooltipTriggerEl.getAttribute("data-bs-title"),
    )
    .map((tooltipTriggerEl) => new bootstrap.Tooltip(tooltipTriggerEl));

  board.svg.on("click", (event) => {
    if (event.target.tagName !== "circle") {
      resetState();
    }
  });

  d3.select("body").on("keydown", (event) => {
    if (event.key === "Escape") {
      resetState();
      resetZoom();
    }
  });

  let bboxes = [];
  $clusterSelect.append(`<option disabled selected>to center</option>`);
  board.setCentroids.forEach((item, i) => {
    let cid = `#c${sanitizeForQuerySelector(item[settings.indexedDB.keyPath])}`;
    let tid = `#t${sanitizeForQuerySelector(item[settings.indexedDB.keyPath])}`;

    let thisBBox = d3.select(tid)._groups[0][0].getBBox();
    let overlap = true;
    bboxes.forEach((otherBBox) => {
      overlap &= getOverlapFromTwoExtents(thisBBox, otherBBox);
    });
    if (overlap) {
      bboxes.push(thisBBox);
      d3.select(tid).attr("opacity", 1);
      d3.select(tid).data(d3.select(cid).data()[0]);
      d3.select(cid).attr("fill", "#000000").attr("opacity", 1);
    }

    $clusterSelect.append(
      `<option value="${item?.[settings.indexedDB.keyPath]}">${item[config.labels.title]}</option>`,
    );
  });
}

function changeCluster(e) {
  let clickedCircleValue = $("#clusterSelect option:selected").val();
  if (clickedCircleValue == "") {
    return;
  }

  let selectedCircle = board["circles"].filter(function (circle) {
    return circle?.[settings.indexedDB.keyPath] == clickedCircleValue;
  });

  let id = selectedCircle.attr("id");
  if (!id) {
    return;
  }

  let data = selectedCircle.data()[0];

  centerNode(id);
  updateCircles(data?.cluster);
  showCluster(data);
  $menuOffcanvas.hide();
}

async function setupObjectStoreSelect() {
  let db = await openDatabase(settings.indexedDB, true);
  let objectStoreNames = [...db.objectStoreNames];
  db.close();

  let html = objectStoreNames.reduce((accumulator, objectStoreName) => {
    return (
      accumulator +
      `<option value="${objectStoreName}">${objectStoreName}</option>`
    );
  }, `<option disabled selected>datasets</option>`);

  $("#objectStoreSelect").html(html);
}

function isRegex(input) {
  // Check if the input starts and ends with a slash
  return /^\/.*\/[gimsuy]*$/.test(input);
}

function parseInput(input) {
  if (isRegex(input)) {
    try {
      // Extract the pattern and flags
      const matches = input.match(/^\/(.*)\/([gimsuy]*)$/);
      const pattern = matches[1];
      const flags = matches[2];

      // Create a RegExp object
      const regex = new RegExp(pattern, flags);
      return regex;
    } catch (e) {
      // Invalid regex pattern
      return null;
    }
  } else {
    // Input is a plain string
    return input.trim();
  }
}

async function init() {
  await initializeSettings();

  setupObjectStoreSelect();
  $(document).on("change", "#objectStoreSelect", async function () {
    let name = $(this).val();
    let res = await firstEntry({}, name);
    config.fields.available = new Set(Object.keys(res));
    setupSelects();
  });

  $("#regenerateMap").on("click", async function () {
    settings.indexedDB.tableName = $(
      "#objectStoreSelect option:selected",
    ).val();
    await loadData(settings.indexedDB.tableName);
    generateMap();
  });

  $("#autoColorClusters").on("click", colorClusters);
  $("#resetZoom").on("click", resetZoom);

  $clusterSelect.on("change", changeCluster);

  $("#urlRegexBtn").on("click", function () {
    let pattern = {
      attr: null,
      regex: null,
      color: null,
    };
    pattern.regex = $("#attrRegex").val();
    if (!pattern.regex) {
      console.error("missing regex");
      return;
    }
    pattern.regex = parseInput(pattern.regex);

    pattern.color = $("#attrRegexColor").val();
    if (!pattern.color) {
      console.error("missing color");
      return;
    }
    pattern.attr = $("#colorFields option:selected").val();
    if (!pattern.attr) {
      console.error("missing attr");
      return;
    }
    config.regexes.push(pattern);
    colorByRegexes();
  });
  $(document).on("click", ".removeColor", function () {
    let data = $(this).data();
    $("#attrRegex").val(data.regex);
    $("#attrRegexColor").val(data.color);
    $("#colorFields").val(data.attr);
    colorCircles({
      attr: data.attr,
      regex: data.regex,
      color: config.colors.default,
    });
    let indexToRemove = parseInt(data.index, 10);
    console.log(indexToRemove);
    config.regexes = config.regexes.filter(
      (_, index) => index !== indexToRemove,
    );
    $("#coloring li").eq(indexToRemove).remove();
    colorByRegexes();
  });

  $(document).on("change", "#titleSelect", function () {
    config.labels.title = $("#titleSelect option:selected").val();
    board?.labels?.text((d) => d[config.labels.title]);
  });

  $(document).on("change", "#descriptionSelect", function () {
    config.labels.description = $("#descriptionSelect option:selected").val();
  });

  $offcanvasRightElement.addEventListener("hide.bs.offcanvas", (event) => {
    resetState();
    console.log("hide");
  });
}
init();
