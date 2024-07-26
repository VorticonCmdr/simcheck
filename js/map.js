import { settings, initializeSettings } from "/js/settings.js";

import "/libs/d3.min.v7.9.0.js";
import { firstEntry, openDatabase } from "/js/indexeddb.js";
import { generateTable } from "/js/table.js";

import { Flatbush } from "/libs/flatbush.js";

const $menuOffcanvas = new bootstrap.Offcanvas("#offcanvasMenu");
const $bsOffcanvas = new bootstrap.Offcanvas("#offcanvasRight");
const $offcanvasRightElement = document.getElementById("offcanvasRight");
const $clusterSelect = $("#clusterSelect");

let mapData = {};

let board = {
  flatbushIndex: null,
  mapsData: [],
  coordinates: [],
  selectedCircles: [],
  sums: [],
  numberOfClusters: 1,
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
  ZOOM_DELAY: 100,
  zooming: false,
  zoomTimeout: null,
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
    disabled: new Set([
      "embeddings",
      "clusterNumber",
      "order",
      "coordinates",
      "dbscanCluster",
      "center",
    ]),
    available: new Set(),
  },
  regexes: [],
  circles: {
    size: 1,
  },
  labels: {
    title: null,
    description: null,
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
          board.mapsData = Object.values(mapData);
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
      let selected = "";
      if (currentValue == config.labels.title) {
        selected = "selected";
      }
      return `${accumulator}\n<option value="${currentValue}" ${selected}>${currentValue}</option>`;
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

function buildFlatbush() {
  const t0 = performance.now();
  board.flatbushIndex = new Flatbush(board.mapsData.length);
  board.mapsData.forEach((item) => {
    board.flatbushIndex.add(
      board.xScale(item.coordinates[0]),
      board.yScale(item.coordinates[1]),
    );
  });
  board.flatbushIndex.finish();
  const t1 = performance.now();
  console.log(`flatbushIndex took ${t1 - t0} milliseconds.`);
}

// Throttle function implementation
function throttle(func, limit) {
  let lastFunc;
  let lastRan;
  return function () {
    const context = this;
    const args = arguments;
    if (!lastRan) {
      func.apply(context, args);
      lastRan = Date.now();
    } else {
      clearTimeout(lastFunc);
      lastFunc = setTimeout(
        function () {
          if (Date.now() - lastRan >= limit) {
            func.apply(context, args);
            lastRan = Date.now();
          }
        },
        limit - (Date.now() - lastRan),
      );
    }
  };
}

// Function to get all circles currently in view
function getVisibleCircles() {
  const svg = document.querySelector("svg");
  const svgRect = svg.getBoundingClientRect();
  const circles = svg.querySelectorAll("circle");
  const visibleCircles = [];

  circles.forEach((circle) => {
    const circleRect = circle.getBoundingClientRect();

    // Check if circle is in view
    if (
      circleRect.right > svgRect.left &&
      circleRect.left < svgRect.right &&
      circleRect.bottom > svgRect.top &&
      circleRect.top < svgRect.bottom
    ) {
      visibleCircles.push(circle);
    }
  });

  const circleIds = visibleCircles.map((circle) => `#${circle.id}`);
  return d3.selectAll(circleIds.join(", "));
}

const throttledGetVisibleCircles = throttle(() => {
  const visibleCircles = getVisibleCircles();
  //visibleCircles.attr("stroke", "blue");
}, 200);

function handleZoom(event) {
  board["circles"].style("display", (d) => {
    return d.center || d.clicked ? null : "none";
  });
  //throttledGetVisibleCircles();
  //svg.attr("transform", event.transform);
  d3.selectAll(".datalayer").attr("transform", event.transform);
  let found = board.flatbushIndex
    .search(
      event.transform.invertX(0),
      event.transform.invertY(0),
      event.transform.invertX(board.width),
      event.transform.invertY(board.height),
    )
    .map((i) => board.mapsData[i]);
  console.log(event.transform.k);
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
  let colors = generateColors(board.numberOfClusters);
  colors.forEach((color, i) => {
    board.circles
      .filter(function (d) {
        return d && d.dbscanCluster == i;
      })
      .attr("fill", color)
      .attr("opacity", config.opacity.default)
      .attr("r", config.circles.size);
  });
}

function colorCircles(pattern) {
  board.circles
    .filter(function (d) {
      return d && d?.[pattern.attr].match(pattern.regex);
    })
    .attr("fill", pattern.color)
    .attr("opacity", config.opacity.default)
    .attr("r", config.circles.size);
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

function getCircleCoordinates(clickedCircle) {
  const selectedCircles = board["circles"].filter(function (circle) {
    if (circle.dbscanCluster == clickedCircle.dbscanCluster) {
      if (circle === clickedCircle) {
        circle.clicked = true;
      } else {
        circle.clicked = false;
      }
      return true;
    }
    return false;
  });

  // Extract x/y coordinates
  const coordinates = selectedCircles.nodes().map((circle) => {
    const cx = parseFloat(circle.getAttribute("cx"));
    const cy = parseFloat(circle.getAttribute("cy"));
    return { x: cx, y: cy };
  });

  return coordinates;
}

function showCluster(clickedCircle) {
  $("#offcanvasRightLabel").text("");
  $("#offcanvasRightLabel").text(clickedCircle.dbscanCluster);

  $("#accordionRelated").empty();

  let circles = board["circles"]
    .filter(function (circle) {
      if (circle.dbscanCluster == clickedCircle.dbscanCluster) {
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

  generateTable(circles);

  let html = Handlebars.templates.accordionItem(items);
  $("#accordionRelated").html(html);
  $bsOffcanvas.show();
}

function circleClick(pointerEvent, clickedCircle) {
  clearTimeout(board.zoomTimeout);
  console.log("circleClick");
  centerNode(pointerEvent.target.id);
  updateCircles(clickedCircle.dbscanCluster);
  showCluster(clickedCircle);
}

function updateCircles(selectedCluster) {
  board["circles"]
    .filter((d) => d.dbscanCluster == selectedCluster)
    .attr("opacity", config.opacity.selected)
    .attr("stroke", "red");

  board["circles"]
    .filter((d) => d.dbscanCluster != selectedCluster)
    .attr("opacity", config.opacity.unselected)
    .attr("stroke", null);
}

function resetState() {
  board["circles"].attr("opacity", config.opacity.default).attr("stroke", null);
}

function debounce(func, wait) {
  let timeout;
  return function (...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function generateMap() {
  if (board.svg) {
    board.svg.selectAll("*").remove();
  }

  board["svg"] = d3
    .select("#map")
    .attr("height", board.height)
    .attr("width", board.width);

  board.svg
    .append("text")
    .attr("id", "loading")
    .attr("x", board.width / 2) // Position text in the center horizontally
    .attr("y", board.height / 2) // Position text in the center vertically
    .attr("text-anchor", "middle") // Center the text horizontally around the x position
    .attr("dy", ".35em") // Adjust the y position to center the text vertically
    .text("loading …")
    .attr("class", "center-text"); // Add a class for styling if needed

  await delay(0);

  $("#board").toggleClass("visible");
  $("#table").toggleClass("invisible");

  board.coordinates = board.mapsData.map((item) => {
    return {
      x: item.coordinates[0],
      y: item.coordinates[1],
    };
  });

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
    .attr("class", "datalayer labels")
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

  buildFlatbush();

  // append circles last to be on top
  board["circles"] = board.svg
    .append("g")
    .attr("class", "datalayer")
    .selectAll("circle")
    .data(board.mapsData)
    .join("circle")
    .attr("class", (d) => {
      if (d.center) {
        return "circle center";
      }
      return "circle";
    })
    .attr("id", (d) => {
      return `c${sanitizeForQuerySelector(d[settings.indexedDB.keyPath])}`;
    })
    .attr("cx", (d) => board.xScale(d.coordinates[0]))
    .attr("cy", (d) => board.yScale(d.coordinates[1]))
    .attr("r", config.circles.size)
    .attr("fill", config.colors.default)
    .attr("opacity", config.opacity.default)
    .attr("data-bs-toggle", "tooltip")
    .on("click", circleClick);

  //prepareBlurMap(board.circles, 2);

  board["zoom"] = d3.zoom().on("zoom", (event) => {
    svg.attr("transform", event.transform);
  });

  board["zoom"] = d3
    .zoom()
    .filter((event) => {
      return !board.activeBrush;
    })
    .on("start", (event) => {
      board.zooming = true;
      clearTimeout(board.zoomTimeout);
      d3.select(".labels").style("display", "none");
      //d3.select(".grid").style("display", "none");
    })
    .on("zoom", handleZoom)
    .on("end", () => {
      board.zoomTimeout = setTimeout(() => {
        board.zooming = false;
        d3.select(".labels").style("display", null);
        //d3.select(".grid").style("display", null);
        board["circles"].style("display", null);
      }, board.ZOOM_DELAY);
    });

  // initZoom
  board["zoomer"] = d3.select("svg").call(board["zoom"]);

  initializeTooltips();

  board.svg.on("click", (event) => {
    console.log("svg click");
    clearTimeout(board.zoomTimeout);
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

  setupClusterSelect();

  if (config.labels.title) {
    setupBoundingBoxes();
  }

  board.svg.select("#loading").remove();
}

function setupClusterSelect() {
  board.numberOfClusters = 0;
  $clusterSelect.empty();
  $clusterSelect.append(`<option disabled selected>to center</option>`);
  board.mapsData
    .filter((d) => d.center)
    .forEach((item, i) => {
      board.numberOfClusters++;
      $clusterSelect.append(
        `<option value="${item?.[settings.indexedDB.keyPath]}">${item?.[config.labels.title]}</option>`,
      );
    });
}

function prepareBlurMap(circles, sigma) {
  const data = getCoordinatesFromCircles(circles);

  const width = board.width; // Width of the grid
  const height = board.height; // Height of the grid
  const gridSize = 3; // Size of each grid cell

  let gridWidth = Math.ceil(width / gridSize);
  let gridHeight = Math.ceil(height / gridSize);
  let grid = Array.from({ length: gridHeight }, () => Array(gridWidth).fill(0));

  // Map points to grid
  data.forEach((point) => {
    const x = Math.floor(point.x / gridSize);
    const y = Math.floor(point.y / gridSize);
    grid[y][x] += 1;
  });

  let blurredGrid = gaussianBlur(grid, sigma, gridWidth, gridHeight, gridSize);

  const customColorScale = d3
    .scaleLinear()
    .domain([0, d3.max(blurredGrid.flat())])
    .range(["rgb(235, 239, 247)", "rgb(144, 224, 190)"]);

  board["grid"] = board.svg
    .insert("g", ":first-child")
    .attr("class", "datalayer grid")
    .selectAll("rect")
    .data(blurredGrid.flat())
    .enter()
    .append("rect")
    .attr("x", (d, i) => (i % gridWidth) * gridSize)
    .attr("y", (d, i) => Math.floor(i / gridWidth) * gridSize)
    .attr("width", gridSize)
    .attr("height", gridSize)
    .attr("fill", (d) => customColorScale(d));
}

function gaussianBlur(grid, sigma, gridWidth, gridHeight, gridSize) {
  let kernelSize = Math.ceil(sigma * 3);
  let kernel = [];
  let kernelSum = 0;

  // Create Gaussian kernel
  for (let y = -kernelSize; y <= kernelSize; y++) {
    for (let x = -kernelSize; x <= kernelSize; x++) {
      const value = Math.exp(-(x * x + y * y) / (2 * sigma * sigma));
      kernel.push({ x, y, value });
      kernelSum += value;
    }
  }

  let blurredGrid = Array.from({ length: gridHeight }, () =>
    Array(gridWidth).fill(0),
  );

  // Apply kernel to grid
  for (let y = 0; y < gridHeight; y++) {
    for (let x = 0; x < gridWidth; x++) {
      let sum = 0;
      kernel.forEach(({ x: kx, y: ky, value }) => {
        const ix = x + kx;
        const iy = y + ky;
        if (ix >= 0 && ix < gridWidth && iy >= 0 && iy < gridHeight) {
          sum += grid[iy][ix] * value;
        }
      });
      blurredGrid[y][x] = sum / kernelSum;
    }
  }

  return blurredGrid;
}

function getCoordinatesFromCircles(circles) {
  return circles._groups[0].map((circle) => {
    const cx = circle.getAttribute("cx");
    const cy = circle.getAttribute("cy");
    return { x: parseFloat(cx), y: parseFloat(cy) };
  });
}

function initializeTooltips() {
  let tooltipTriggerList = document.querySelectorAll(
    '[data-bs-toggle="tooltip"]',
  );
  let tooltipList = [...tooltipTriggerList]
    .filter(
      (tooltipTriggerEl) => tooltipTriggerEl.__data__[config.labels.title],
    )
    .map(
      (tooltipTriggerEl) =>
        new bootstrap.Tooltip(tooltipTriggerEl, {
          title: tooltipTriggerEl.__data__[config.labels.title],
        }),
    );
}

function setupBoundingBoxes() {
  let bboxes = [];
  board.mapsData
    .filter((d) => d.center)
    .forEach((item, i) => {
      let id = sanitizeForQuerySelector(item[settings.indexedDB.keyPath]);
      let cid = `#c${id}`;
      let tid = `#t${id}`;

      let thisBBox = d3.select(tid)._groups[0][0]?.getBBox();
      if (!thisBBox) {
        return;
      }
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
  updateCircles(data?.dbscanCluster);
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
    if (!name) {
      return;
    }
    board?.svg?.selectAll("*").remove();
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
    config.regexes = config.regexes.filter(
      (_, index) => index !== indexToRemove,
    );
    $("#coloring li").eq(indexToRemove).remove();
    colorByRegexes();
  });

  $(document).on("change", "#titleSelect", function () {
    config.labels.title = $("#titleSelect option:selected").val();

    if (!board["labels"]) {
      return;
    }
    board["labels"].attr("opacity", 0);
    board?.labels?.filter((d) => d.center).text((d) => d[config.labels.title]);
    board?.circles.attr("data-bs-toggle", "tooltip");

    setupClusterSelect();
    initializeTooltips();
    setupBoundingBoxes();
  });

  $(document).on("change", "#descriptionSelect", function () {
    config.labels.description = $("#descriptionSelect option:selected").val();
  });

  $offcanvasRightElement.addEventListener("hide.bs.offcanvas", (event) => {
    resetState();
  });
}
init();
