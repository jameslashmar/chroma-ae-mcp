"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// node_modules/pngjs/lib/chunkstream.js
var require_chunkstream = __commonJS({
  "node_modules/pngjs/lib/chunkstream.js"(exports2, module2) {
    "use strict";
    var util2 = require("util");
    var Stream = require("stream");
    var ChunkStream = module2.exports = function() {
      Stream.call(this);
      this._buffers = [];
      this._buffered = 0;
      this._reads = [];
      this._paused = false;
      this._encoding = "utf8";
      this.writable = true;
    };
    util2.inherits(ChunkStream, Stream);
    ChunkStream.prototype.read = function(length, callback) {
      this._reads.push({
        length: Math.abs(length),
        // if length < 0 then at most this length
        allowLess: length < 0,
        func: callback
      });
      process.nextTick(
        function() {
          this._process();
          if (this._paused && this._reads && this._reads.length > 0) {
            this._paused = false;
            this.emit("drain");
          }
        }.bind(this)
      );
    };
    ChunkStream.prototype.write = function(data, encoding) {
      if (!this.writable) {
        this.emit("error", new Error("Stream not writable"));
        return false;
      }
      let dataBuffer;
      if (Buffer.isBuffer(data)) {
        dataBuffer = data;
      } else {
        dataBuffer = Buffer.from(data, encoding || this._encoding);
      }
      this._buffers.push(dataBuffer);
      this._buffered += dataBuffer.length;
      this._process();
      if (this._reads && this._reads.length === 0) {
        this._paused = true;
      }
      return this.writable && !this._paused;
    };
    ChunkStream.prototype.end = function(data, encoding) {
      if (data) {
        this.write(data, encoding);
      }
      this.writable = false;
      if (!this._buffers) {
        return;
      }
      if (this._buffers.length === 0) {
        this._end();
      } else {
        this._buffers.push(null);
        this._process();
      }
    };
    ChunkStream.prototype.destroySoon = ChunkStream.prototype.end;
    ChunkStream.prototype._end = function() {
      if (this._reads.length > 0) {
        this.emit("error", new Error("Unexpected end of input"));
      }
      this.destroy();
    };
    ChunkStream.prototype.destroy = function() {
      if (!this._buffers) {
        return;
      }
      this.writable = false;
      this._reads = null;
      this._buffers = null;
      this.emit("close");
    };
    ChunkStream.prototype._processReadAllowingLess = function(read) {
      this._reads.shift();
      let smallerBuf = this._buffers[0];
      if (smallerBuf.length > read.length) {
        this._buffered -= read.length;
        this._buffers[0] = smallerBuf.slice(read.length);
        read.func.call(this, smallerBuf.slice(0, read.length));
      } else {
        this._buffered -= smallerBuf.length;
        this._buffers.shift();
        read.func.call(this, smallerBuf);
      }
    };
    ChunkStream.prototype._processRead = function(read) {
      this._reads.shift();
      let pos = 0;
      let count = 0;
      let data = Buffer.alloc(read.length);
      while (pos < read.length) {
        let buf = this._buffers[count++];
        let len = Math.min(buf.length, read.length - pos);
        buf.copy(data, pos, 0, len);
        pos += len;
        if (len !== buf.length) {
          this._buffers[--count] = buf.slice(len);
        }
      }
      if (count > 0) {
        this._buffers.splice(0, count);
      }
      this._buffered -= read.length;
      read.func.call(this, data);
    };
    ChunkStream.prototype._process = function() {
      try {
        while (this._buffered > 0 && this._reads && this._reads.length > 0) {
          let read = this._reads[0];
          if (read.allowLess) {
            this._processReadAllowingLess(read);
          } else if (this._buffered >= read.length) {
            this._processRead(read);
          } else {
            break;
          }
        }
        if (this._buffers && !this.writable) {
          this._end();
        }
      } catch (ex) {
        this.emit("error", ex);
      }
    };
  }
});

// node_modules/pngjs/lib/interlace.js
var require_interlace = __commonJS({
  "node_modules/pngjs/lib/interlace.js"(exports2) {
    "use strict";
    var imagePasses = [
      {
        // pass 1 - 1px
        x: [0],
        y: [0]
      },
      {
        // pass 2 - 1px
        x: [4],
        y: [0]
      },
      {
        // pass 3 - 2px
        x: [0, 4],
        y: [4]
      },
      {
        // pass 4 - 4px
        x: [2, 6],
        y: [0, 4]
      },
      {
        // pass 5 - 8px
        x: [0, 2, 4, 6],
        y: [2, 6]
      },
      {
        // pass 6 - 16px
        x: [1, 3, 5, 7],
        y: [0, 2, 4, 6]
      },
      {
        // pass 7 - 32px
        x: [0, 1, 2, 3, 4, 5, 6, 7],
        y: [1, 3, 5, 7]
      }
    ];
    exports2.getImagePasses = function(width, height) {
      let images = [];
      let xLeftOver = width % 8;
      let yLeftOver = height % 8;
      let xRepeats = (width - xLeftOver) / 8;
      let yRepeats = (height - yLeftOver) / 8;
      for (let i = 0; i < imagePasses.length; i++) {
        let pass = imagePasses[i];
        let passWidth = xRepeats * pass.x.length;
        let passHeight = yRepeats * pass.y.length;
        for (let j = 0; j < pass.x.length; j++) {
          if (pass.x[j] < xLeftOver) {
            passWidth++;
          } else {
            break;
          }
        }
        for (let j = 0; j < pass.y.length; j++) {
          if (pass.y[j] < yLeftOver) {
            passHeight++;
          } else {
            break;
          }
        }
        if (passWidth > 0 && passHeight > 0) {
          images.push({ width: passWidth, height: passHeight, index: i });
        }
      }
      return images;
    };
    exports2.getInterlaceIterator = function(width) {
      return function(x, y, pass) {
        let outerXLeftOver = x % imagePasses[pass].x.length;
        let outerX = (x - outerXLeftOver) / imagePasses[pass].x.length * 8 + imagePasses[pass].x[outerXLeftOver];
        let outerYLeftOver = y % imagePasses[pass].y.length;
        let outerY = (y - outerYLeftOver) / imagePasses[pass].y.length * 8 + imagePasses[pass].y[outerYLeftOver];
        return outerX * 4 + outerY * width * 4;
      };
    };
  }
});

// node_modules/pngjs/lib/paeth-predictor.js
var require_paeth_predictor = __commonJS({
  "node_modules/pngjs/lib/paeth-predictor.js"(exports2, module2) {
    "use strict";
    module2.exports = function paethPredictor(left, above, upLeft) {
      let paeth = left + above - upLeft;
      let pLeft = Math.abs(paeth - left);
      let pAbove = Math.abs(paeth - above);
      let pUpLeft = Math.abs(paeth - upLeft);
      if (pLeft <= pAbove && pLeft <= pUpLeft) {
        return left;
      }
      if (pAbove <= pUpLeft) {
        return above;
      }
      return upLeft;
    };
  }
});

// node_modules/pngjs/lib/filter-parse.js
var require_filter_parse = __commonJS({
  "node_modules/pngjs/lib/filter-parse.js"(exports2, module2) {
    "use strict";
    var interlaceUtils = require_interlace();
    var paethPredictor = require_paeth_predictor();
    function getByteWidth(width, bpp, depth) {
      let byteWidth = width * bpp;
      if (depth !== 8) {
        byteWidth = Math.ceil(byteWidth / (8 / depth));
      }
      return byteWidth;
    }
    var Filter = module2.exports = function(bitmapInfo, dependencies) {
      let width = bitmapInfo.width;
      let height = bitmapInfo.height;
      let interlace = bitmapInfo.interlace;
      let bpp = bitmapInfo.bpp;
      let depth = bitmapInfo.depth;
      this.read = dependencies.read;
      this.write = dependencies.write;
      this.complete = dependencies.complete;
      this._imageIndex = 0;
      this._images = [];
      if (interlace) {
        let passes = interlaceUtils.getImagePasses(width, height);
        for (let i = 0; i < passes.length; i++) {
          this._images.push({
            byteWidth: getByteWidth(passes[i].width, bpp, depth),
            height: passes[i].height,
            lineIndex: 0
          });
        }
      } else {
        this._images.push({
          byteWidth: getByteWidth(width, bpp, depth),
          height,
          lineIndex: 0
        });
      }
      if (depth === 8) {
        this._xComparison = bpp;
      } else if (depth === 16) {
        this._xComparison = bpp * 2;
      } else {
        this._xComparison = 1;
      }
    };
    Filter.prototype.start = function() {
      this.read(
        this._images[this._imageIndex].byteWidth + 1,
        this._reverseFilterLine.bind(this)
      );
    };
    Filter.prototype._unFilterType1 = function(rawData, unfilteredLine, byteWidth) {
      let xComparison = this._xComparison;
      let xBiggerThan = xComparison - 1;
      for (let x = 0; x < byteWidth; x++) {
        let rawByte = rawData[1 + x];
        let f1Left = x > xBiggerThan ? unfilteredLine[x - xComparison] : 0;
        unfilteredLine[x] = rawByte + f1Left;
      }
    };
    Filter.prototype._unFilterType2 = function(rawData, unfilteredLine, byteWidth) {
      let lastLine = this._lastLine;
      for (let x = 0; x < byteWidth; x++) {
        let rawByte = rawData[1 + x];
        let f2Up = lastLine ? lastLine[x] : 0;
        unfilteredLine[x] = rawByte + f2Up;
      }
    };
    Filter.prototype._unFilterType3 = function(rawData, unfilteredLine, byteWidth) {
      let xComparison = this._xComparison;
      let xBiggerThan = xComparison - 1;
      let lastLine = this._lastLine;
      for (let x = 0; x < byteWidth; x++) {
        let rawByte = rawData[1 + x];
        let f3Up = lastLine ? lastLine[x] : 0;
        let f3Left = x > xBiggerThan ? unfilteredLine[x - xComparison] : 0;
        let f3Add = Math.floor((f3Left + f3Up) / 2);
        unfilteredLine[x] = rawByte + f3Add;
      }
    };
    Filter.prototype._unFilterType4 = function(rawData, unfilteredLine, byteWidth) {
      let xComparison = this._xComparison;
      let xBiggerThan = xComparison - 1;
      let lastLine = this._lastLine;
      for (let x = 0; x < byteWidth; x++) {
        let rawByte = rawData[1 + x];
        let f4Up = lastLine ? lastLine[x] : 0;
        let f4Left = x > xBiggerThan ? unfilteredLine[x - xComparison] : 0;
        let f4UpLeft = x > xBiggerThan && lastLine ? lastLine[x - xComparison] : 0;
        let f4Add = paethPredictor(f4Left, f4Up, f4UpLeft);
        unfilteredLine[x] = rawByte + f4Add;
      }
    };
    Filter.prototype._reverseFilterLine = function(rawData) {
      let filter = rawData[0];
      let unfilteredLine;
      let currentImage = this._images[this._imageIndex];
      let byteWidth = currentImage.byteWidth;
      if (filter === 0) {
        unfilteredLine = rawData.slice(1, byteWidth + 1);
      } else {
        unfilteredLine = Buffer.alloc(byteWidth);
        switch (filter) {
          case 1:
            this._unFilterType1(rawData, unfilteredLine, byteWidth);
            break;
          case 2:
            this._unFilterType2(rawData, unfilteredLine, byteWidth);
            break;
          case 3:
            this._unFilterType3(rawData, unfilteredLine, byteWidth);
            break;
          case 4:
            this._unFilterType4(rawData, unfilteredLine, byteWidth);
            break;
          default:
            throw new Error("Unrecognised filter type - " + filter);
        }
      }
      this.write(unfilteredLine);
      currentImage.lineIndex++;
      if (currentImage.lineIndex >= currentImage.height) {
        this._lastLine = null;
        this._imageIndex++;
        currentImage = this._images[this._imageIndex];
      } else {
        this._lastLine = unfilteredLine;
      }
      if (currentImage) {
        this.read(currentImage.byteWidth + 1, this._reverseFilterLine.bind(this));
      } else {
        this._lastLine = null;
        this.complete();
      }
    };
  }
});

// node_modules/pngjs/lib/filter-parse-async.js
var require_filter_parse_async = __commonJS({
  "node_modules/pngjs/lib/filter-parse-async.js"(exports2, module2) {
    "use strict";
    var util2 = require("util");
    var ChunkStream = require_chunkstream();
    var Filter = require_filter_parse();
    var FilterAsync = module2.exports = function(bitmapInfo) {
      ChunkStream.call(this);
      let buffers = [];
      let that = this;
      this._filter = new Filter(bitmapInfo, {
        read: this.read.bind(this),
        write: function(buffer) {
          buffers.push(buffer);
        },
        complete: function() {
          that.emit("complete", Buffer.concat(buffers));
        }
      });
      this._filter.start();
    };
    util2.inherits(FilterAsync, ChunkStream);
  }
});

// node_modules/pngjs/lib/constants.js
var require_constants = __commonJS({
  "node_modules/pngjs/lib/constants.js"(exports2, module2) {
    "use strict";
    module2.exports = {
      PNG_SIGNATURE: [137, 80, 78, 71, 13, 10, 26, 10],
      TYPE_IHDR: 1229472850,
      TYPE_IEND: 1229278788,
      TYPE_IDAT: 1229209940,
      TYPE_PLTE: 1347179589,
      TYPE_tRNS: 1951551059,
      // eslint-disable-line camelcase
      TYPE_gAMA: 1732332865,
      // eslint-disable-line camelcase
      // color-type bits
      COLORTYPE_GRAYSCALE: 0,
      COLORTYPE_PALETTE: 1,
      COLORTYPE_COLOR: 2,
      COLORTYPE_ALPHA: 4,
      // e.g. grayscale and alpha
      // color-type combinations
      COLORTYPE_PALETTE_COLOR: 3,
      COLORTYPE_COLOR_ALPHA: 6,
      COLORTYPE_TO_BPP_MAP: {
        0: 1,
        2: 3,
        3: 1,
        4: 2,
        6: 4
      },
      GAMMA_DIVISION: 1e5
    };
  }
});

// node_modules/pngjs/lib/crc.js
var require_crc = __commonJS({
  "node_modules/pngjs/lib/crc.js"(exports2, module2) {
    "use strict";
    var crcTable = [];
    (function() {
      for (let i = 0; i < 256; i++) {
        let currentCrc = i;
        for (let j = 0; j < 8; j++) {
          if (currentCrc & 1) {
            currentCrc = 3988292384 ^ currentCrc >>> 1;
          } else {
            currentCrc = currentCrc >>> 1;
          }
        }
        crcTable[i] = currentCrc;
      }
    })();
    var CrcCalculator = module2.exports = function() {
      this._crc = -1;
    };
    CrcCalculator.prototype.write = function(data) {
      for (let i = 0; i < data.length; i++) {
        this._crc = crcTable[(this._crc ^ data[i]) & 255] ^ this._crc >>> 8;
      }
      return true;
    };
    CrcCalculator.prototype.crc32 = function() {
      return this._crc ^ -1;
    };
    CrcCalculator.crc32 = function(buf) {
      let crc = -1;
      for (let i = 0; i < buf.length; i++) {
        crc = crcTable[(crc ^ buf[i]) & 255] ^ crc >>> 8;
      }
      return crc ^ -1;
    };
  }
});

// node_modules/pngjs/lib/parser.js
var require_parser = __commonJS({
  "node_modules/pngjs/lib/parser.js"(exports2, module2) {
    "use strict";
    var constants2 = require_constants();
    var CrcCalculator = require_crc();
    var Parser = module2.exports = function(options, dependencies) {
      this._options = options;
      options.checkCRC = options.checkCRC !== false;
      this._hasIHDR = false;
      this._hasIEND = false;
      this._emittedHeadersFinished = false;
      this._palette = [];
      this._colorType = 0;
      this._chunks = {};
      this._chunks[constants2.TYPE_IHDR] = this._handleIHDR.bind(this);
      this._chunks[constants2.TYPE_IEND] = this._handleIEND.bind(this);
      this._chunks[constants2.TYPE_IDAT] = this._handleIDAT.bind(this);
      this._chunks[constants2.TYPE_PLTE] = this._handlePLTE.bind(this);
      this._chunks[constants2.TYPE_tRNS] = this._handleTRNS.bind(this);
      this._chunks[constants2.TYPE_gAMA] = this._handleGAMA.bind(this);
      this.read = dependencies.read;
      this.error = dependencies.error;
      this.metadata = dependencies.metadata;
      this.gamma = dependencies.gamma;
      this.transColor = dependencies.transColor;
      this.palette = dependencies.palette;
      this.parsed = dependencies.parsed;
      this.inflateData = dependencies.inflateData;
      this.finished = dependencies.finished;
      this.simpleTransparency = dependencies.simpleTransparency;
      this.headersFinished = dependencies.headersFinished || function() {
      };
    };
    Parser.prototype.start = function() {
      this.read(constants2.PNG_SIGNATURE.length, this._parseSignature.bind(this));
    };
    Parser.prototype._parseSignature = function(data) {
      let signature = constants2.PNG_SIGNATURE;
      for (let i = 0; i < signature.length; i++) {
        if (data[i] !== signature[i]) {
          this.error(new Error("Invalid file signature"));
          return;
        }
      }
      this.read(8, this._parseChunkBegin.bind(this));
    };
    Parser.prototype._parseChunkBegin = function(data) {
      let length = data.readUInt32BE(0);
      let type = data.readUInt32BE(4);
      let name = "";
      for (let i = 4; i < 8; i++) {
        name += String.fromCharCode(data[i]);
      }
      let ancillary = Boolean(data[4] & 32);
      if (!this._hasIHDR && type !== constants2.TYPE_IHDR) {
        this.error(new Error("Expected IHDR on beggining"));
        return;
      }
      this._crc = new CrcCalculator();
      this._crc.write(Buffer.from(name));
      if (this._chunks[type]) {
        return this._chunks[type](length);
      }
      if (!ancillary) {
        this.error(new Error("Unsupported critical chunk type " + name));
        return;
      }
      this.read(length + 4, this._skipChunk.bind(this));
    };
    Parser.prototype._skipChunk = function() {
      this.read(8, this._parseChunkBegin.bind(this));
    };
    Parser.prototype._handleChunkEnd = function() {
      this.read(4, this._parseChunkEnd.bind(this));
    };
    Parser.prototype._parseChunkEnd = function(data) {
      let fileCrc = data.readInt32BE(0);
      let calcCrc = this._crc.crc32();
      if (this._options.checkCRC && calcCrc !== fileCrc) {
        this.error(new Error("Crc error - " + fileCrc + " - " + calcCrc));
        return;
      }
      if (!this._hasIEND) {
        this.read(8, this._parseChunkBegin.bind(this));
      }
    };
    Parser.prototype._handleIHDR = function(length) {
      this.read(length, this._parseIHDR.bind(this));
    };
    Parser.prototype._parseIHDR = function(data) {
      this._crc.write(data);
      let width = data.readUInt32BE(0);
      let height = data.readUInt32BE(4);
      let depth = data[8];
      let colorType = data[9];
      let compr = data[10];
      let filter = data[11];
      let interlace = data[12];
      if (depth !== 8 && depth !== 4 && depth !== 2 && depth !== 1 && depth !== 16) {
        this.error(new Error("Unsupported bit depth " + depth));
        return;
      }
      if (!(colorType in constants2.COLORTYPE_TO_BPP_MAP)) {
        this.error(new Error("Unsupported color type"));
        return;
      }
      if (compr !== 0) {
        this.error(new Error("Unsupported compression method"));
        return;
      }
      if (filter !== 0) {
        this.error(new Error("Unsupported filter method"));
        return;
      }
      if (interlace !== 0 && interlace !== 1) {
        this.error(new Error("Unsupported interlace method"));
        return;
      }
      this._colorType = colorType;
      let bpp = constants2.COLORTYPE_TO_BPP_MAP[this._colorType];
      this._hasIHDR = true;
      this.metadata({
        width,
        height,
        depth,
        interlace: Boolean(interlace),
        palette: Boolean(colorType & constants2.COLORTYPE_PALETTE),
        color: Boolean(colorType & constants2.COLORTYPE_COLOR),
        alpha: Boolean(colorType & constants2.COLORTYPE_ALPHA),
        bpp,
        colorType
      });
      this._handleChunkEnd();
    };
    Parser.prototype._handlePLTE = function(length) {
      this.read(length, this._parsePLTE.bind(this));
    };
    Parser.prototype._parsePLTE = function(data) {
      this._crc.write(data);
      let entries = Math.floor(data.length / 3);
      for (let i = 0; i < entries; i++) {
        this._palette.push([data[i * 3], data[i * 3 + 1], data[i * 3 + 2], 255]);
      }
      this.palette(this._palette);
      this._handleChunkEnd();
    };
    Parser.prototype._handleTRNS = function(length) {
      this.simpleTransparency();
      this.read(length, this._parseTRNS.bind(this));
    };
    Parser.prototype._parseTRNS = function(data) {
      this._crc.write(data);
      if (this._colorType === constants2.COLORTYPE_PALETTE_COLOR) {
        if (this._palette.length === 0) {
          this.error(new Error("Transparency chunk must be after palette"));
          return;
        }
        if (data.length > this._palette.length) {
          this.error(new Error("More transparent colors than palette size"));
          return;
        }
        for (let i = 0; i < data.length; i++) {
          this._palette[i][3] = data[i];
        }
        this.palette(this._palette);
      }
      if (this._colorType === constants2.COLORTYPE_GRAYSCALE) {
        this.transColor([data.readUInt16BE(0)]);
      }
      if (this._colorType === constants2.COLORTYPE_COLOR) {
        this.transColor([
          data.readUInt16BE(0),
          data.readUInt16BE(2),
          data.readUInt16BE(4)
        ]);
      }
      this._handleChunkEnd();
    };
    Parser.prototype._handleGAMA = function(length) {
      this.read(length, this._parseGAMA.bind(this));
    };
    Parser.prototype._parseGAMA = function(data) {
      this._crc.write(data);
      this.gamma(data.readUInt32BE(0) / constants2.GAMMA_DIVISION);
      this._handleChunkEnd();
    };
    Parser.prototype._handleIDAT = function(length) {
      if (!this._emittedHeadersFinished) {
        this._emittedHeadersFinished = true;
        this.headersFinished();
      }
      this.read(-length, this._parseIDAT.bind(this, length));
    };
    Parser.prototype._parseIDAT = function(length, data) {
      this._crc.write(data);
      if (this._colorType === constants2.COLORTYPE_PALETTE_COLOR && this._palette.length === 0) {
        throw new Error("Expected palette not found");
      }
      this.inflateData(data);
      let leftOverLength = length - data.length;
      if (leftOverLength > 0) {
        this._handleIDAT(leftOverLength);
      } else {
        this._handleChunkEnd();
      }
    };
    Parser.prototype._handleIEND = function(length) {
      this.read(length, this._parseIEND.bind(this));
    };
    Parser.prototype._parseIEND = function(data) {
      this._crc.write(data);
      this._hasIEND = true;
      this._handleChunkEnd();
      if (this.finished) {
        this.finished();
      }
    };
  }
});

// node_modules/pngjs/lib/bitmapper.js
var require_bitmapper = __commonJS({
  "node_modules/pngjs/lib/bitmapper.js"(exports2) {
    "use strict";
    var interlaceUtils = require_interlace();
    var pixelBppMapper = [
      // 0 - dummy entry
      function() {
      },
      // 1 - L
      // 0: 0, 1: 0, 2: 0, 3: 0xff
      function(pxData, data, pxPos, rawPos) {
        if (rawPos === data.length) {
          throw new Error("Ran out of data");
        }
        let pixel = data[rawPos];
        pxData[pxPos] = pixel;
        pxData[pxPos + 1] = pixel;
        pxData[pxPos + 2] = pixel;
        pxData[pxPos + 3] = 255;
      },
      // 2 - LA
      // 0: 0, 1: 0, 2: 0, 3: 1
      function(pxData, data, pxPos, rawPos) {
        if (rawPos + 1 >= data.length) {
          throw new Error("Ran out of data");
        }
        let pixel = data[rawPos];
        pxData[pxPos] = pixel;
        pxData[pxPos + 1] = pixel;
        pxData[pxPos + 2] = pixel;
        pxData[pxPos + 3] = data[rawPos + 1];
      },
      // 3 - RGB
      // 0: 0, 1: 1, 2: 2, 3: 0xff
      function(pxData, data, pxPos, rawPos) {
        if (rawPos + 2 >= data.length) {
          throw new Error("Ran out of data");
        }
        pxData[pxPos] = data[rawPos];
        pxData[pxPos + 1] = data[rawPos + 1];
        pxData[pxPos + 2] = data[rawPos + 2];
        pxData[pxPos + 3] = 255;
      },
      // 4 - RGBA
      // 0: 0, 1: 1, 2: 2, 3: 3
      function(pxData, data, pxPos, rawPos) {
        if (rawPos + 3 >= data.length) {
          throw new Error("Ran out of data");
        }
        pxData[pxPos] = data[rawPos];
        pxData[pxPos + 1] = data[rawPos + 1];
        pxData[pxPos + 2] = data[rawPos + 2];
        pxData[pxPos + 3] = data[rawPos + 3];
      }
    ];
    var pixelBppCustomMapper = [
      // 0 - dummy entry
      function() {
      },
      // 1 - L
      // 0: 0, 1: 0, 2: 0, 3: 0xff
      function(pxData, pixelData, pxPos, maxBit) {
        let pixel = pixelData[0];
        pxData[pxPos] = pixel;
        pxData[pxPos + 1] = pixel;
        pxData[pxPos + 2] = pixel;
        pxData[pxPos + 3] = maxBit;
      },
      // 2 - LA
      // 0: 0, 1: 0, 2: 0, 3: 1
      function(pxData, pixelData, pxPos) {
        let pixel = pixelData[0];
        pxData[pxPos] = pixel;
        pxData[pxPos + 1] = pixel;
        pxData[pxPos + 2] = pixel;
        pxData[pxPos + 3] = pixelData[1];
      },
      // 3 - RGB
      // 0: 0, 1: 1, 2: 2, 3: 0xff
      function(pxData, pixelData, pxPos, maxBit) {
        pxData[pxPos] = pixelData[0];
        pxData[pxPos + 1] = pixelData[1];
        pxData[pxPos + 2] = pixelData[2];
        pxData[pxPos + 3] = maxBit;
      },
      // 4 - RGBA
      // 0: 0, 1: 1, 2: 2, 3: 3
      function(pxData, pixelData, pxPos) {
        pxData[pxPos] = pixelData[0];
        pxData[pxPos + 1] = pixelData[1];
        pxData[pxPos + 2] = pixelData[2];
        pxData[pxPos + 3] = pixelData[3];
      }
    ];
    function bitRetriever(data, depth) {
      let leftOver = [];
      let i = 0;
      function split() {
        if (i === data.length) {
          throw new Error("Ran out of data");
        }
        let byte = data[i];
        i++;
        let byte8, byte7, byte6, byte5, byte4, byte3, byte2, byte1;
        switch (depth) {
          default:
            throw new Error("unrecognised depth");
          case 16:
            byte2 = data[i];
            i++;
            leftOver.push((byte << 8) + byte2);
            break;
          case 4:
            byte2 = byte & 15;
            byte1 = byte >> 4;
            leftOver.push(byte1, byte2);
            break;
          case 2:
            byte4 = byte & 3;
            byte3 = byte >> 2 & 3;
            byte2 = byte >> 4 & 3;
            byte1 = byte >> 6 & 3;
            leftOver.push(byte1, byte2, byte3, byte4);
            break;
          case 1:
            byte8 = byte & 1;
            byte7 = byte >> 1 & 1;
            byte6 = byte >> 2 & 1;
            byte5 = byte >> 3 & 1;
            byte4 = byte >> 4 & 1;
            byte3 = byte >> 5 & 1;
            byte2 = byte >> 6 & 1;
            byte1 = byte >> 7 & 1;
            leftOver.push(byte1, byte2, byte3, byte4, byte5, byte6, byte7, byte8);
            break;
        }
      }
      return {
        get: function(count) {
          while (leftOver.length < count) {
            split();
          }
          let returner = leftOver.slice(0, count);
          leftOver = leftOver.slice(count);
          return returner;
        },
        resetAfterLine: function() {
          leftOver.length = 0;
        },
        end: function() {
          if (i !== data.length) {
            throw new Error("extra data found");
          }
        }
      };
    }
    function mapImage8Bit(image, pxData, getPxPos, bpp, data, rawPos) {
      let imageWidth = image.width;
      let imageHeight = image.height;
      let imagePass = image.index;
      for (let y = 0; y < imageHeight; y++) {
        for (let x = 0; x < imageWidth; x++) {
          let pxPos = getPxPos(x, y, imagePass);
          pixelBppMapper[bpp](pxData, data, pxPos, rawPos);
          rawPos += bpp;
        }
      }
      return rawPos;
    }
    function mapImageCustomBit(image, pxData, getPxPos, bpp, bits, maxBit) {
      let imageWidth = image.width;
      let imageHeight = image.height;
      let imagePass = image.index;
      for (let y = 0; y < imageHeight; y++) {
        for (let x = 0; x < imageWidth; x++) {
          let pixelData = bits.get(bpp);
          let pxPos = getPxPos(x, y, imagePass);
          pixelBppCustomMapper[bpp](pxData, pixelData, pxPos, maxBit);
        }
        bits.resetAfterLine();
      }
    }
    exports2.dataToBitMap = function(data, bitmapInfo) {
      let width = bitmapInfo.width;
      let height = bitmapInfo.height;
      let depth = bitmapInfo.depth;
      let bpp = bitmapInfo.bpp;
      let interlace = bitmapInfo.interlace;
      let bits;
      if (depth !== 8) {
        bits = bitRetriever(data, depth);
      }
      let pxData;
      if (depth <= 8) {
        pxData = Buffer.alloc(width * height * 4);
      } else {
        pxData = new Uint16Array(width * height * 4);
      }
      let maxBit = Math.pow(2, depth) - 1;
      let rawPos = 0;
      let images;
      let getPxPos;
      if (interlace) {
        images = interlaceUtils.getImagePasses(width, height);
        getPxPos = interlaceUtils.getInterlaceIterator(width, height);
      } else {
        let nonInterlacedPxPos = 0;
        getPxPos = function() {
          let returner = nonInterlacedPxPos;
          nonInterlacedPxPos += 4;
          return returner;
        };
        images = [{ width, height }];
      }
      for (let imageIndex = 0; imageIndex < images.length; imageIndex++) {
        if (depth === 8) {
          rawPos = mapImage8Bit(
            images[imageIndex],
            pxData,
            getPxPos,
            bpp,
            data,
            rawPos
          );
        } else {
          mapImageCustomBit(
            images[imageIndex],
            pxData,
            getPxPos,
            bpp,
            bits,
            maxBit
          );
        }
      }
      if (depth === 8) {
        if (rawPos !== data.length) {
          throw new Error("extra data found");
        }
      } else {
        bits.end();
      }
      return pxData;
    };
  }
});

// node_modules/pngjs/lib/format-normaliser.js
var require_format_normaliser = __commonJS({
  "node_modules/pngjs/lib/format-normaliser.js"(exports2, module2) {
    "use strict";
    function dePalette(indata, outdata, width, height, palette) {
      let pxPos = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          let color = palette[indata[pxPos]];
          if (!color) {
            throw new Error("index " + indata[pxPos] + " not in palette");
          }
          for (let i = 0; i < 4; i++) {
            outdata[pxPos + i] = color[i];
          }
          pxPos += 4;
        }
      }
    }
    function replaceTransparentColor(indata, outdata, width, height, transColor) {
      let pxPos = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          let makeTrans = false;
          if (transColor.length === 1) {
            if (transColor[0] === indata[pxPos]) {
              makeTrans = true;
            }
          } else if (transColor[0] === indata[pxPos] && transColor[1] === indata[pxPos + 1] && transColor[2] === indata[pxPos + 2]) {
            makeTrans = true;
          }
          if (makeTrans) {
            for (let i = 0; i < 4; i++) {
              outdata[pxPos + i] = 0;
            }
          }
          pxPos += 4;
        }
      }
    }
    function scaleDepth(indata, outdata, width, height, depth) {
      let maxOutSample = 255;
      let maxInSample = Math.pow(2, depth) - 1;
      let pxPos = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          for (let i = 0; i < 4; i++) {
            outdata[pxPos + i] = Math.floor(
              indata[pxPos + i] * maxOutSample / maxInSample + 0.5
            );
          }
          pxPos += 4;
        }
      }
    }
    module2.exports = function(indata, imageData, skipRescale = false) {
      let depth = imageData.depth;
      let width = imageData.width;
      let height = imageData.height;
      let colorType = imageData.colorType;
      let transColor = imageData.transColor;
      let palette = imageData.palette;
      let outdata = indata;
      if (colorType === 3) {
        dePalette(indata, outdata, width, height, palette);
      } else {
        if (transColor) {
          replaceTransparentColor(indata, outdata, width, height, transColor);
        }
        if (depth !== 8 && !skipRescale) {
          if (depth === 16) {
            outdata = Buffer.alloc(width * height * 4);
          }
          scaleDepth(indata, outdata, width, height, depth);
        }
      }
      return outdata;
    };
  }
});

// node_modules/pngjs/lib/parser-async.js
var require_parser_async = __commonJS({
  "node_modules/pngjs/lib/parser-async.js"(exports2, module2) {
    "use strict";
    var util2 = require("util");
    var zlib = require("zlib");
    var ChunkStream = require_chunkstream();
    var FilterAsync = require_filter_parse_async();
    var Parser = require_parser();
    var bitmapper = require_bitmapper();
    var formatNormaliser = require_format_normaliser();
    var ParserAsync = module2.exports = function(options) {
      ChunkStream.call(this);
      this._parser = new Parser(options, {
        read: this.read.bind(this),
        error: this._handleError.bind(this),
        metadata: this._handleMetaData.bind(this),
        gamma: this.emit.bind(this, "gamma"),
        palette: this._handlePalette.bind(this),
        transColor: this._handleTransColor.bind(this),
        finished: this._finished.bind(this),
        inflateData: this._inflateData.bind(this),
        simpleTransparency: this._simpleTransparency.bind(this),
        headersFinished: this._headersFinished.bind(this)
      });
      this._options = options;
      this.writable = true;
      this._parser.start();
    };
    util2.inherits(ParserAsync, ChunkStream);
    ParserAsync.prototype._handleError = function(err) {
      this.emit("error", err);
      this.writable = false;
      this.destroy();
      if (this._inflate && this._inflate.destroy) {
        this._inflate.destroy();
      }
      if (this._filter) {
        this._filter.destroy();
        this._filter.on("error", function() {
        });
      }
      this.errord = true;
    };
    ParserAsync.prototype._inflateData = function(data) {
      if (!this._inflate) {
        if (this._bitmapInfo.interlace) {
          this._inflate = zlib.createInflate();
          this._inflate.on("error", this.emit.bind(this, "error"));
          this._filter.on("complete", this._complete.bind(this));
          this._inflate.pipe(this._filter);
        } else {
          let rowSize = (this._bitmapInfo.width * this._bitmapInfo.bpp * this._bitmapInfo.depth + 7 >> 3) + 1;
          let imageSize = rowSize * this._bitmapInfo.height;
          let chunkSize = Math.max(imageSize, zlib.Z_MIN_CHUNK);
          this._inflate = zlib.createInflate({ chunkSize });
          let leftToInflate = imageSize;
          let emitError = this.emit.bind(this, "error");
          this._inflate.on("error", function(err) {
            if (!leftToInflate) {
              return;
            }
            emitError(err);
          });
          this._filter.on("complete", this._complete.bind(this));
          let filterWrite = this._filter.write.bind(this._filter);
          this._inflate.on("data", function(chunk) {
            if (!leftToInflate) {
              return;
            }
            if (chunk.length > leftToInflate) {
              chunk = chunk.slice(0, leftToInflate);
            }
            leftToInflate -= chunk.length;
            filterWrite(chunk);
          });
          this._inflate.on("end", this._filter.end.bind(this._filter));
        }
      }
      this._inflate.write(data);
    };
    ParserAsync.prototype._handleMetaData = function(metaData) {
      this._metaData = metaData;
      this._bitmapInfo = Object.create(metaData);
      this._filter = new FilterAsync(this._bitmapInfo);
    };
    ParserAsync.prototype._handleTransColor = function(transColor) {
      this._bitmapInfo.transColor = transColor;
    };
    ParserAsync.prototype._handlePalette = function(palette) {
      this._bitmapInfo.palette = palette;
    };
    ParserAsync.prototype._simpleTransparency = function() {
      this._metaData.alpha = true;
    };
    ParserAsync.prototype._headersFinished = function() {
      this.emit("metadata", this._metaData);
    };
    ParserAsync.prototype._finished = function() {
      if (this.errord) {
        return;
      }
      if (!this._inflate) {
        this.emit("error", "No Inflate block");
      } else {
        this._inflate.end();
      }
    };
    ParserAsync.prototype._complete = function(filteredData) {
      if (this.errord) {
        return;
      }
      let normalisedBitmapData;
      try {
        let bitmapData = bitmapper.dataToBitMap(filteredData, this._bitmapInfo);
        normalisedBitmapData = formatNormaliser(
          bitmapData,
          this._bitmapInfo,
          this._options.skipRescale
        );
        bitmapData = null;
      } catch (ex) {
        this._handleError(ex);
        return;
      }
      this.emit("parsed", normalisedBitmapData);
    };
  }
});

// node_modules/pngjs/lib/bitpacker.js
var require_bitpacker = __commonJS({
  "node_modules/pngjs/lib/bitpacker.js"(exports2, module2) {
    "use strict";
    var constants2 = require_constants();
    module2.exports = function(dataIn, width, height, options) {
      let outHasAlpha = [constants2.COLORTYPE_COLOR_ALPHA, constants2.COLORTYPE_ALPHA].indexOf(
        options.colorType
      ) !== -1;
      if (options.colorType === options.inputColorType) {
        let bigEndian = function() {
          let buffer = new ArrayBuffer(2);
          new DataView(buffer).setInt16(
            0,
            256,
            true
            /* littleEndian */
          );
          return new Int16Array(buffer)[0] !== 256;
        }();
        if (options.bitDepth === 8 || options.bitDepth === 16 && bigEndian) {
          return dataIn;
        }
      }
      let data = options.bitDepth !== 16 ? dataIn : new Uint16Array(dataIn.buffer);
      let maxValue = 255;
      let inBpp = constants2.COLORTYPE_TO_BPP_MAP[options.inputColorType];
      if (inBpp === 4 && !options.inputHasAlpha) {
        inBpp = 3;
      }
      let outBpp = constants2.COLORTYPE_TO_BPP_MAP[options.colorType];
      if (options.bitDepth === 16) {
        maxValue = 65535;
        outBpp *= 2;
      }
      let outData = Buffer.alloc(width * height * outBpp);
      let inIndex = 0;
      let outIndex = 0;
      let bgColor = options.bgColor || {};
      if (bgColor.red === void 0) {
        bgColor.red = maxValue;
      }
      if (bgColor.green === void 0) {
        bgColor.green = maxValue;
      }
      if (bgColor.blue === void 0) {
        bgColor.blue = maxValue;
      }
      function getRGBA() {
        let red;
        let green;
        let blue;
        let alpha = maxValue;
        switch (options.inputColorType) {
          case constants2.COLORTYPE_COLOR_ALPHA:
            alpha = data[inIndex + 3];
            red = data[inIndex];
            green = data[inIndex + 1];
            blue = data[inIndex + 2];
            break;
          case constants2.COLORTYPE_COLOR:
            red = data[inIndex];
            green = data[inIndex + 1];
            blue = data[inIndex + 2];
            break;
          case constants2.COLORTYPE_ALPHA:
            alpha = data[inIndex + 1];
            red = data[inIndex];
            green = red;
            blue = red;
            break;
          case constants2.COLORTYPE_GRAYSCALE:
            red = data[inIndex];
            green = red;
            blue = red;
            break;
          default:
            throw new Error(
              "input color type:" + options.inputColorType + " is not supported at present"
            );
        }
        if (options.inputHasAlpha) {
          if (!outHasAlpha) {
            alpha /= maxValue;
            red = Math.min(
              Math.max(Math.round((1 - alpha) * bgColor.red + alpha * red), 0),
              maxValue
            );
            green = Math.min(
              Math.max(Math.round((1 - alpha) * bgColor.green + alpha * green), 0),
              maxValue
            );
            blue = Math.min(
              Math.max(Math.round((1 - alpha) * bgColor.blue + alpha * blue), 0),
              maxValue
            );
          }
        }
        return { red, green, blue, alpha };
      }
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          let rgba = getRGBA(data, inIndex);
          switch (options.colorType) {
            case constants2.COLORTYPE_COLOR_ALPHA:
            case constants2.COLORTYPE_COLOR:
              if (options.bitDepth === 8) {
                outData[outIndex] = rgba.red;
                outData[outIndex + 1] = rgba.green;
                outData[outIndex + 2] = rgba.blue;
                if (outHasAlpha) {
                  outData[outIndex + 3] = rgba.alpha;
                }
              } else {
                outData.writeUInt16BE(rgba.red, outIndex);
                outData.writeUInt16BE(rgba.green, outIndex + 2);
                outData.writeUInt16BE(rgba.blue, outIndex + 4);
                if (outHasAlpha) {
                  outData.writeUInt16BE(rgba.alpha, outIndex + 6);
                }
              }
              break;
            case constants2.COLORTYPE_ALPHA:
            case constants2.COLORTYPE_GRAYSCALE: {
              let grayscale = (rgba.red + rgba.green + rgba.blue) / 3;
              if (options.bitDepth === 8) {
                outData[outIndex] = grayscale;
                if (outHasAlpha) {
                  outData[outIndex + 1] = rgba.alpha;
                }
              } else {
                outData.writeUInt16BE(grayscale, outIndex);
                if (outHasAlpha) {
                  outData.writeUInt16BE(rgba.alpha, outIndex + 2);
                }
              }
              break;
            }
            default:
              throw new Error("unrecognised color Type " + options.colorType);
          }
          inIndex += inBpp;
          outIndex += outBpp;
        }
      }
      return outData;
    };
  }
});

// node_modules/pngjs/lib/filter-pack.js
var require_filter_pack = __commonJS({
  "node_modules/pngjs/lib/filter-pack.js"(exports2, module2) {
    "use strict";
    var paethPredictor = require_paeth_predictor();
    function filterNone(pxData, pxPos, byteWidth, rawData, rawPos) {
      for (let x = 0; x < byteWidth; x++) {
        rawData[rawPos + x] = pxData[pxPos + x];
      }
    }
    function filterSumNone(pxData, pxPos, byteWidth) {
      let sum = 0;
      let length = pxPos + byteWidth;
      for (let i = pxPos; i < length; i++) {
        sum += Math.abs(pxData[i]);
      }
      return sum;
    }
    function filterSub(pxData, pxPos, byteWidth, rawData, rawPos, bpp) {
      for (let x = 0; x < byteWidth; x++) {
        let left = x >= bpp ? pxData[pxPos + x - bpp] : 0;
        let val = pxData[pxPos + x] - left;
        rawData[rawPos + x] = val;
      }
    }
    function filterSumSub(pxData, pxPos, byteWidth, bpp) {
      let sum = 0;
      for (let x = 0; x < byteWidth; x++) {
        let left = x >= bpp ? pxData[pxPos + x - bpp] : 0;
        let val = pxData[pxPos + x] - left;
        sum += Math.abs(val);
      }
      return sum;
    }
    function filterUp(pxData, pxPos, byteWidth, rawData, rawPos) {
      for (let x = 0; x < byteWidth; x++) {
        let up = pxPos > 0 ? pxData[pxPos + x - byteWidth] : 0;
        let val = pxData[pxPos + x] - up;
        rawData[rawPos + x] = val;
      }
    }
    function filterSumUp(pxData, pxPos, byteWidth) {
      let sum = 0;
      let length = pxPos + byteWidth;
      for (let x = pxPos; x < length; x++) {
        let up = pxPos > 0 ? pxData[x - byteWidth] : 0;
        let val = pxData[x] - up;
        sum += Math.abs(val);
      }
      return sum;
    }
    function filterAvg(pxData, pxPos, byteWidth, rawData, rawPos, bpp) {
      for (let x = 0; x < byteWidth; x++) {
        let left = x >= bpp ? pxData[pxPos + x - bpp] : 0;
        let up = pxPos > 0 ? pxData[pxPos + x - byteWidth] : 0;
        let val = pxData[pxPos + x] - (left + up >> 1);
        rawData[rawPos + x] = val;
      }
    }
    function filterSumAvg(pxData, pxPos, byteWidth, bpp) {
      let sum = 0;
      for (let x = 0; x < byteWidth; x++) {
        let left = x >= bpp ? pxData[pxPos + x - bpp] : 0;
        let up = pxPos > 0 ? pxData[pxPos + x - byteWidth] : 0;
        let val = pxData[pxPos + x] - (left + up >> 1);
        sum += Math.abs(val);
      }
      return sum;
    }
    function filterPaeth(pxData, pxPos, byteWidth, rawData, rawPos, bpp) {
      for (let x = 0; x < byteWidth; x++) {
        let left = x >= bpp ? pxData[pxPos + x - bpp] : 0;
        let up = pxPos > 0 ? pxData[pxPos + x - byteWidth] : 0;
        let upleft = pxPos > 0 && x >= bpp ? pxData[pxPos + x - (byteWidth + bpp)] : 0;
        let val = pxData[pxPos + x] - paethPredictor(left, up, upleft);
        rawData[rawPos + x] = val;
      }
    }
    function filterSumPaeth(pxData, pxPos, byteWidth, bpp) {
      let sum = 0;
      for (let x = 0; x < byteWidth; x++) {
        let left = x >= bpp ? pxData[pxPos + x - bpp] : 0;
        let up = pxPos > 0 ? pxData[pxPos + x - byteWidth] : 0;
        let upleft = pxPos > 0 && x >= bpp ? pxData[pxPos + x - (byteWidth + bpp)] : 0;
        let val = pxData[pxPos + x] - paethPredictor(left, up, upleft);
        sum += Math.abs(val);
      }
      return sum;
    }
    var filters = {
      0: filterNone,
      1: filterSub,
      2: filterUp,
      3: filterAvg,
      4: filterPaeth
    };
    var filterSums = {
      0: filterSumNone,
      1: filterSumSub,
      2: filterSumUp,
      3: filterSumAvg,
      4: filterSumPaeth
    };
    module2.exports = function(pxData, width, height, options, bpp) {
      let filterTypes;
      if (!("filterType" in options) || options.filterType === -1) {
        filterTypes = [0, 1, 2, 3, 4];
      } else if (typeof options.filterType === "number") {
        filterTypes = [options.filterType];
      } else {
        throw new Error("unrecognised filter types");
      }
      if (options.bitDepth === 16) {
        bpp *= 2;
      }
      let byteWidth = width * bpp;
      let rawPos = 0;
      let pxPos = 0;
      let rawData = Buffer.alloc((byteWidth + 1) * height);
      let sel = filterTypes[0];
      for (let y = 0; y < height; y++) {
        if (filterTypes.length > 1) {
          let min = Infinity;
          for (let i = 0; i < filterTypes.length; i++) {
            let sum = filterSums[filterTypes[i]](pxData, pxPos, byteWidth, bpp);
            if (sum < min) {
              sel = filterTypes[i];
              min = sum;
            }
          }
        }
        rawData[rawPos] = sel;
        rawPos++;
        filters[sel](pxData, pxPos, byteWidth, rawData, rawPos, bpp);
        rawPos += byteWidth;
        pxPos += byteWidth;
      }
      return rawData;
    };
  }
});

// node_modules/pngjs/lib/packer.js
var require_packer = __commonJS({
  "node_modules/pngjs/lib/packer.js"(exports2, module2) {
    "use strict";
    var constants2 = require_constants();
    var CrcStream = require_crc();
    var bitPacker = require_bitpacker();
    var filter = require_filter_pack();
    var zlib = require("zlib");
    var Packer = module2.exports = function(options) {
      this._options = options;
      options.deflateChunkSize = options.deflateChunkSize || 32 * 1024;
      options.deflateLevel = options.deflateLevel != null ? options.deflateLevel : 9;
      options.deflateStrategy = options.deflateStrategy != null ? options.deflateStrategy : 3;
      options.inputHasAlpha = options.inputHasAlpha != null ? options.inputHasAlpha : true;
      options.deflateFactory = options.deflateFactory || zlib.createDeflate;
      options.bitDepth = options.bitDepth || 8;
      options.colorType = typeof options.colorType === "number" ? options.colorType : constants2.COLORTYPE_COLOR_ALPHA;
      options.inputColorType = typeof options.inputColorType === "number" ? options.inputColorType : constants2.COLORTYPE_COLOR_ALPHA;
      if ([
        constants2.COLORTYPE_GRAYSCALE,
        constants2.COLORTYPE_COLOR,
        constants2.COLORTYPE_COLOR_ALPHA,
        constants2.COLORTYPE_ALPHA
      ].indexOf(options.colorType) === -1) {
        throw new Error(
          "option color type:" + options.colorType + " is not supported at present"
        );
      }
      if ([
        constants2.COLORTYPE_GRAYSCALE,
        constants2.COLORTYPE_COLOR,
        constants2.COLORTYPE_COLOR_ALPHA,
        constants2.COLORTYPE_ALPHA
      ].indexOf(options.inputColorType) === -1) {
        throw new Error(
          "option input color type:" + options.inputColorType + " is not supported at present"
        );
      }
      if (options.bitDepth !== 8 && options.bitDepth !== 16) {
        throw new Error(
          "option bit depth:" + options.bitDepth + " is not supported at present"
        );
      }
    };
    Packer.prototype.getDeflateOptions = function() {
      return {
        chunkSize: this._options.deflateChunkSize,
        level: this._options.deflateLevel,
        strategy: this._options.deflateStrategy
      };
    };
    Packer.prototype.createDeflate = function() {
      return this._options.deflateFactory(this.getDeflateOptions());
    };
    Packer.prototype.filterData = function(data, width, height) {
      let packedData = bitPacker(data, width, height, this._options);
      let bpp = constants2.COLORTYPE_TO_BPP_MAP[this._options.colorType];
      let filteredData = filter(packedData, width, height, this._options, bpp);
      return filteredData;
    };
    Packer.prototype._packChunk = function(type, data) {
      let len = data ? data.length : 0;
      let buf = Buffer.alloc(len + 12);
      buf.writeUInt32BE(len, 0);
      buf.writeUInt32BE(type, 4);
      if (data) {
        data.copy(buf, 8);
      }
      buf.writeInt32BE(
        CrcStream.crc32(buf.slice(4, buf.length - 4)),
        buf.length - 4
      );
      return buf;
    };
    Packer.prototype.packGAMA = function(gamma) {
      let buf = Buffer.alloc(4);
      buf.writeUInt32BE(Math.floor(gamma * constants2.GAMMA_DIVISION), 0);
      return this._packChunk(constants2.TYPE_gAMA, buf);
    };
    Packer.prototype.packIHDR = function(width, height) {
      let buf = Buffer.alloc(13);
      buf.writeUInt32BE(width, 0);
      buf.writeUInt32BE(height, 4);
      buf[8] = this._options.bitDepth;
      buf[9] = this._options.colorType;
      buf[10] = 0;
      buf[11] = 0;
      buf[12] = 0;
      return this._packChunk(constants2.TYPE_IHDR, buf);
    };
    Packer.prototype.packIDAT = function(data) {
      return this._packChunk(constants2.TYPE_IDAT, data);
    };
    Packer.prototype.packIEND = function() {
      return this._packChunk(constants2.TYPE_IEND, null);
    };
  }
});

// node_modules/pngjs/lib/packer-async.js
var require_packer_async = __commonJS({
  "node_modules/pngjs/lib/packer-async.js"(exports2, module2) {
    "use strict";
    var util2 = require("util");
    var Stream = require("stream");
    var constants2 = require_constants();
    var Packer = require_packer();
    var PackerAsync = module2.exports = function(opt) {
      Stream.call(this);
      let options = opt || {};
      this._packer = new Packer(options);
      this._deflate = this._packer.createDeflate();
      this.readable = true;
    };
    util2.inherits(PackerAsync, Stream);
    PackerAsync.prototype.pack = function(data, width, height, gamma) {
      this.emit("data", Buffer.from(constants2.PNG_SIGNATURE));
      this.emit("data", this._packer.packIHDR(width, height));
      if (gamma) {
        this.emit("data", this._packer.packGAMA(gamma));
      }
      let filteredData = this._packer.filterData(data, width, height);
      this._deflate.on("error", this.emit.bind(this, "error"));
      this._deflate.on(
        "data",
        function(compressedData) {
          this.emit("data", this._packer.packIDAT(compressedData));
        }.bind(this)
      );
      this._deflate.on(
        "end",
        function() {
          this.emit("data", this._packer.packIEND());
          this.emit("end");
        }.bind(this)
      );
      this._deflate.end(filteredData);
    };
  }
});

// node_modules/pngjs/lib/sync-inflate.js
var require_sync_inflate = __commonJS({
  "node_modules/pngjs/lib/sync-inflate.js"(exports2, module2) {
    "use strict";
    var assert = require("assert").ok;
    var zlib = require("zlib");
    var util2 = require("util");
    var kMaxLength = require("buffer").kMaxLength;
    function Inflate(opts) {
      if (!(this instanceof Inflate)) {
        return new Inflate(opts);
      }
      if (opts && opts.chunkSize < zlib.Z_MIN_CHUNK) {
        opts.chunkSize = zlib.Z_MIN_CHUNK;
      }
      zlib.Inflate.call(this, opts);
      this._offset = this._offset === void 0 ? this._outOffset : this._offset;
      this._buffer = this._buffer || this._outBuffer;
      if (opts && opts.maxLength != null) {
        this._maxLength = opts.maxLength;
      }
    }
    function createInflate(opts) {
      return new Inflate(opts);
    }
    function _close(engine, callback) {
      if (callback) {
        process.nextTick(callback);
      }
      if (!engine._handle) {
        return;
      }
      engine._handle.close();
      engine._handle = null;
    }
    Inflate.prototype._processChunk = function(chunk, flushFlag, asyncCb) {
      if (typeof asyncCb === "function") {
        return zlib.Inflate._processChunk.call(this, chunk, flushFlag, asyncCb);
      }
      let self = this;
      let availInBefore = chunk && chunk.length;
      let availOutBefore = this._chunkSize - this._offset;
      let leftToInflate = this._maxLength;
      let inOff = 0;
      let buffers = [];
      let nread = 0;
      let error;
      this.on("error", function(err) {
        error = err;
      });
      function handleChunk(availInAfter, availOutAfter) {
        if (self._hadError) {
          return;
        }
        let have = availOutBefore - availOutAfter;
        assert(have >= 0, "have should not go down");
        if (have > 0) {
          let out = self._buffer.slice(self._offset, self._offset + have);
          self._offset += have;
          if (out.length > leftToInflate) {
            out = out.slice(0, leftToInflate);
          }
          buffers.push(out);
          nread += out.length;
          leftToInflate -= out.length;
          if (leftToInflate === 0) {
            return false;
          }
        }
        if (availOutAfter === 0 || self._offset >= self._chunkSize) {
          availOutBefore = self._chunkSize;
          self._offset = 0;
          self._buffer = Buffer.allocUnsafe(self._chunkSize);
        }
        if (availOutAfter === 0) {
          inOff += availInBefore - availInAfter;
          availInBefore = availInAfter;
          return true;
        }
        return false;
      }
      assert(this._handle, "zlib binding closed");
      let res;
      do {
        res = this._handle.writeSync(
          flushFlag,
          chunk,
          // in
          inOff,
          // in_off
          availInBefore,
          // in_len
          this._buffer,
          // out
          this._offset,
          //out_off
          availOutBefore
        );
        res = res || this._writeState;
      } while (!this._hadError && handleChunk(res[0], res[1]));
      if (this._hadError) {
        throw error;
      }
      if (nread >= kMaxLength) {
        _close(this);
        throw new RangeError(
          "Cannot create final Buffer. It would be larger than 0x" + kMaxLength.toString(16) + " bytes"
        );
      }
      let buf = Buffer.concat(buffers, nread);
      _close(this);
      return buf;
    };
    util2.inherits(Inflate, zlib.Inflate);
    function zlibBufferSync(engine, buffer) {
      if (typeof buffer === "string") {
        buffer = Buffer.from(buffer);
      }
      if (!(buffer instanceof Buffer)) {
        throw new TypeError("Not a string or buffer");
      }
      let flushFlag = engine._finishFlushFlag;
      if (flushFlag == null) {
        flushFlag = zlib.Z_FINISH;
      }
      return engine._processChunk(buffer, flushFlag);
    }
    function inflateSync(buffer, opts) {
      return zlibBufferSync(new Inflate(opts), buffer);
    }
    module2.exports = exports2 = inflateSync;
    exports2.Inflate = Inflate;
    exports2.createInflate = createInflate;
    exports2.inflateSync = inflateSync;
  }
});

// node_modules/pngjs/lib/sync-reader.js
var require_sync_reader = __commonJS({
  "node_modules/pngjs/lib/sync-reader.js"(exports2, module2) {
    "use strict";
    var SyncReader = module2.exports = function(buffer) {
      this._buffer = buffer;
      this._reads = [];
    };
    SyncReader.prototype.read = function(length, callback) {
      this._reads.push({
        length: Math.abs(length),
        // if length < 0 then at most this length
        allowLess: length < 0,
        func: callback
      });
    };
    SyncReader.prototype.process = function() {
      while (this._reads.length > 0 && this._buffer.length) {
        let read = this._reads[0];
        if (this._buffer.length && (this._buffer.length >= read.length || read.allowLess)) {
          this._reads.shift();
          let buf = this._buffer;
          this._buffer = buf.slice(read.length);
          read.func.call(this, buf.slice(0, read.length));
        } else {
          break;
        }
      }
      if (this._reads.length > 0) {
        throw new Error("There are some read requests waitng on finished stream");
      }
      if (this._buffer.length > 0) {
        throw new Error("unrecognised content at end of stream");
      }
    };
  }
});

// node_modules/pngjs/lib/filter-parse-sync.js
var require_filter_parse_sync = __commonJS({
  "node_modules/pngjs/lib/filter-parse-sync.js"(exports2) {
    "use strict";
    var SyncReader = require_sync_reader();
    var Filter = require_filter_parse();
    exports2.process = function(inBuffer, bitmapInfo) {
      let outBuffers = [];
      let reader = new SyncReader(inBuffer);
      let filter = new Filter(bitmapInfo, {
        read: reader.read.bind(reader),
        write: function(bufferPart) {
          outBuffers.push(bufferPart);
        },
        complete: function() {
        }
      });
      filter.start();
      reader.process();
      return Buffer.concat(outBuffers);
    };
  }
});

// node_modules/pngjs/lib/parser-sync.js
var require_parser_sync = __commonJS({
  "node_modules/pngjs/lib/parser-sync.js"(exports2, module2) {
    "use strict";
    var hasSyncZlib = true;
    var zlib = require("zlib");
    var inflateSync = require_sync_inflate();
    if (!zlib.deflateSync) {
      hasSyncZlib = false;
    }
    var SyncReader = require_sync_reader();
    var FilterSync = require_filter_parse_sync();
    var Parser = require_parser();
    var bitmapper = require_bitmapper();
    var formatNormaliser = require_format_normaliser();
    module2.exports = function(buffer, options) {
      if (!hasSyncZlib) {
        throw new Error(
          "To use the sync capability of this library in old node versions, please pin pngjs to v2.3.0"
        );
      }
      let err;
      function handleError(_err_) {
        err = _err_;
      }
      let metaData;
      function handleMetaData(_metaData_) {
        metaData = _metaData_;
      }
      function handleTransColor(transColor) {
        metaData.transColor = transColor;
      }
      function handlePalette(palette) {
        metaData.palette = palette;
      }
      function handleSimpleTransparency() {
        metaData.alpha = true;
      }
      let gamma;
      function handleGamma(_gamma_) {
        gamma = _gamma_;
      }
      let inflateDataList = [];
      function handleInflateData(inflatedData2) {
        inflateDataList.push(inflatedData2);
      }
      let reader = new SyncReader(buffer);
      let parser = new Parser(options, {
        read: reader.read.bind(reader),
        error: handleError,
        metadata: handleMetaData,
        gamma: handleGamma,
        palette: handlePalette,
        transColor: handleTransColor,
        inflateData: handleInflateData,
        simpleTransparency: handleSimpleTransparency
      });
      parser.start();
      reader.process();
      if (err) {
        throw err;
      }
      let inflateData = Buffer.concat(inflateDataList);
      inflateDataList.length = 0;
      let inflatedData;
      if (metaData.interlace) {
        inflatedData = zlib.inflateSync(inflateData);
      } else {
        let rowSize = (metaData.width * metaData.bpp * metaData.depth + 7 >> 3) + 1;
        let imageSize = rowSize * metaData.height;
        inflatedData = inflateSync(inflateData, {
          chunkSize: imageSize,
          maxLength: imageSize
        });
      }
      inflateData = null;
      if (!inflatedData || !inflatedData.length) {
        throw new Error("bad png - invalid inflate data response");
      }
      let unfilteredData = FilterSync.process(inflatedData, metaData);
      inflateData = null;
      let bitmapData = bitmapper.dataToBitMap(unfilteredData, metaData);
      unfilteredData = null;
      let normalisedBitmapData = formatNormaliser(
        bitmapData,
        metaData,
        options.skipRescale
      );
      metaData.data = normalisedBitmapData;
      metaData.gamma = gamma || 0;
      return metaData;
    };
  }
});

// node_modules/pngjs/lib/packer-sync.js
var require_packer_sync = __commonJS({
  "node_modules/pngjs/lib/packer-sync.js"(exports2, module2) {
    "use strict";
    var hasSyncZlib = true;
    var zlib = require("zlib");
    if (!zlib.deflateSync) {
      hasSyncZlib = false;
    }
    var constants2 = require_constants();
    var Packer = require_packer();
    module2.exports = function(metaData, opt) {
      if (!hasSyncZlib) {
        throw new Error(
          "To use the sync capability of this library in old node versions, please pin pngjs to v2.3.0"
        );
      }
      let options = opt || {};
      let packer = new Packer(options);
      let chunks = [];
      chunks.push(Buffer.from(constants2.PNG_SIGNATURE));
      chunks.push(packer.packIHDR(metaData.width, metaData.height));
      if (metaData.gamma) {
        chunks.push(packer.packGAMA(metaData.gamma));
      }
      let filteredData = packer.filterData(
        metaData.data,
        metaData.width,
        metaData.height
      );
      let compressedData = zlib.deflateSync(
        filteredData,
        packer.getDeflateOptions()
      );
      filteredData = null;
      if (!compressedData || !compressedData.length) {
        throw new Error("bad png - invalid compressed data response");
      }
      chunks.push(packer.packIDAT(compressedData));
      chunks.push(packer.packIEND());
      return Buffer.concat(chunks);
    };
  }
});

// node_modules/pngjs/lib/png-sync.js
var require_png_sync = __commonJS({
  "node_modules/pngjs/lib/png-sync.js"(exports2) {
    "use strict";
    var parse = require_parser_sync();
    var pack = require_packer_sync();
    exports2.read = function(buffer, options) {
      return parse(buffer, options || {});
    };
    exports2.write = function(png, options) {
      return pack(png, options);
    };
  }
});

// node_modules/pngjs/lib/png.js
var require_png = __commonJS({
  "node_modules/pngjs/lib/png.js"(exports2) {
    "use strict";
    var util2 = require("util");
    var Stream = require("stream");
    var Parser = require_parser_async();
    var Packer = require_packer_async();
    var PNGSync = require_png_sync();
    var PNG3 = exports2.PNG = function(options) {
      Stream.call(this);
      options = options || {};
      this.width = options.width | 0;
      this.height = options.height | 0;
      this.data = this.width > 0 && this.height > 0 ? Buffer.alloc(4 * this.width * this.height) : null;
      if (options.fill && this.data) {
        this.data.fill(0);
      }
      this.gamma = 0;
      this.readable = this.writable = true;
      this._parser = new Parser(options);
      this._parser.on("error", this.emit.bind(this, "error"));
      this._parser.on("close", this._handleClose.bind(this));
      this._parser.on("metadata", this._metadata.bind(this));
      this._parser.on("gamma", this._gamma.bind(this));
      this._parser.on(
        "parsed",
        function(data) {
          this.data = data;
          this.emit("parsed", data);
        }.bind(this)
      );
      this._packer = new Packer(options);
      this._packer.on("data", this.emit.bind(this, "data"));
      this._packer.on("end", this.emit.bind(this, "end"));
      this._parser.on("close", this._handleClose.bind(this));
      this._packer.on("error", this.emit.bind(this, "error"));
    };
    util2.inherits(PNG3, Stream);
    PNG3.sync = PNGSync;
    PNG3.prototype.pack = function() {
      if (!this.data || !this.data.length) {
        this.emit("error", "No data provided");
        return this;
      }
      process.nextTick(
        function() {
          this._packer.pack(this.data, this.width, this.height, this.gamma);
        }.bind(this)
      );
      return this;
    };
    PNG3.prototype.parse = function(data, callback) {
      if (callback) {
        let onParsed, onError;
        onParsed = function(parsedData) {
          this.removeListener("error", onError);
          this.data = parsedData;
          callback(null, this);
        }.bind(this);
        onError = function(err) {
          this.removeListener("parsed", onParsed);
          callback(err, null);
        }.bind(this);
        this.once("parsed", onParsed);
        this.once("error", onError);
      }
      this.end(data);
      return this;
    };
    PNG3.prototype.write = function(data) {
      this._parser.write(data);
      return true;
    };
    PNG3.prototype.end = function(data) {
      this._parser.end(data);
    };
    PNG3.prototype._metadata = function(metadata) {
      this.width = metadata.width;
      this.height = metadata.height;
      this.emit("metadata", metadata);
    };
    PNG3.prototype._gamma = function(gamma) {
      this.gamma = gamma;
    };
    PNG3.prototype._handleClose = function() {
      if (!this._parser.writable && !this._packer.readable) {
        this.emit("close");
      }
    };
    PNG3.bitblt = function(src, dst, srcX, srcY, width, height, deltaX, deltaY) {
      srcX |= 0;
      srcY |= 0;
      width |= 0;
      height |= 0;
      deltaX |= 0;
      deltaY |= 0;
      if (srcX > src.width || srcY > src.height || srcX + width > src.width || srcY + height > src.height) {
        throw new Error("bitblt reading outside image");
      }
      if (deltaX > dst.width || deltaY > dst.height || deltaX + width > dst.width || deltaY + height > dst.height) {
        throw new Error("bitblt writing outside image");
      }
      for (let y = 0; y < height; y++) {
        src.data.copy(
          dst.data,
          (deltaY + y) * dst.width + deltaX << 2,
          (srcY + y) * src.width + srcX << 2,
          (srcY + y) * src.width + srcX + width << 2
        );
      }
    };
    PNG3.prototype.bitblt = function(dst, srcX, srcY, width, height, deltaX, deltaY) {
      PNG3.bitblt(this, dst, srcX, srcY, width, height, deltaX, deltaY);
      return this;
    };
    PNG3.adjustGamma = function(src) {
      if (src.gamma) {
        for (let y = 0; y < src.height; y++) {
          for (let x = 0; x < src.width; x++) {
            let idx = src.width * y + x << 2;
            for (let i = 0; i < 3; i++) {
              let sample = src.data[idx + i] / 255;
              sample = Math.pow(sample, 1 / 2.2 / src.gamma);
              src.data[idx + i] = Math.round(sample * 255);
            }
          }
        }
        src.gamma = 0;
      }
    };
    PNG3.prototype.adjustGamma = function() {
      PNG3.adjustGamma(this);
    };
  }
});

// src/panel-entry.ts
var panel_entry_exports = {};
__export(panel_entry_exports, {
  PanelHost: () => PanelHost,
  createPanelMcp: () => createPanelMcp,
  handleRpc: () => handleRpc
});
module.exports = __toCommonJS(panel_entry_exports);

// src/asks.ts
var KEEP_ANSWERED_MS = 60 * 60 * 1e3;
var MAX_OPEN = 20;
var AskStore = class {
  constructor(now = Date.now) {
    this.now = now;
  }
  entries = /* @__PURE__ */ new Map();
  counter = 0;
  ask(q) {
    this.prune();
    if (this.open().length >= MAX_OPEN) {
      throw new Error(`There are already ${MAX_OPEN} unanswered questions in the panel.`);
    }
    this.counter += 1;
    const question = {
      ...q,
      id: `ask_${this.now().toString(36)}_${this.counter}`,
      asked_at: this.now()
    };
    this.entries.set(question.id, { question, waiters: [] });
    return question;
  }
  /** Unanswered questions, oldest first. */
  open() {
    return [...this.entries.values()].filter((e) => !e.answer).map((e) => e.question);
  }
  get(id) {
    const e = this.entries.get(id);
    return e ? { question: e.question, answer: e.answer } : null;
  }
  answer(id, reply) {
    const e = this.entries.get(id);
    if (!e) return { ok: false, error: "unknown question" };
    if (e.answer) return { ok: false, error: "already answered" };
    const q = e.question;
    let answer;
    if (reply.dismissed) {
      answer = { status: "dismissed", choice_ids: [], answered_at: this.now() };
    } else {
      const known = new Set(q.options.map((o) => o.id));
      const ids = [...new Set(reply.choice_ids ?? [])];
      const unknown = ids.filter((i) => !known.has(i));
      if (unknown.length > 0) return { ok: false, error: `unknown option ${unknown.join(", ")}` };
      if (!q.multi_select && ids.length > 1) return { ok: false, error: "only one option may be chosen" };
      const other = typeof reply.other === "string" ? reply.other.trim().slice(0, 2e3) : "";
      if (other && !q.allow_other) return { ok: false, error: "this question takes no free-text answer" };
      const curve = validCurve(reply.curve);
      if (ids.length === 0 && !other && !curve) return { ok: false, error: "empty answer" };
      answer = {
        status: "answered",
        choice_ids: ids,
        ...other ? { other } : {},
        ...q.kind === "ease" && curve ? { curve } : {},
        answered_at: this.now()
      };
    }
    e.answer = answer;
    const waiters = e.waiters.splice(0);
    for (const w of waiters) w(answer);
    return { ok: true, answer };
  }
  /** Resolves with the answer, or null when `ms` passes first. */
  wait(id, ms) {
    const e = this.entries.get(id);
    if (!e) return Promise.resolve(null);
    if (e.answer) return Promise.resolve(e.answer);
    return new Promise((resolve2) => {
      const waiter = (a) => {
        clearTimeout(timer);
        resolve2(a);
      };
      const timer = setTimeout(() => {
        const i = e.waiters.indexOf(waiter);
        if (i >= 0) e.waiters.splice(i, 1);
        resolve2(null);
      }, ms);
      e.waiters.push(waiter);
    });
  }
  prune() {
    const cutoff = this.now() - KEEP_ANSWERED_MS;
    for (const [id, e] of this.entries) {
      if (e.answer && e.answer.answered_at < cutoff) this.entries.delete(id);
    }
  }
};
function validCurve(curve) {
  if (!Array.isArray(curve) || curve.length !== 4) return void 0;
  if (!curve.every((n) => typeof n === "number" && Number.isFinite(n))) return void 0;
  if (curve[0] < 0 || curve[0] > 1 || curve[2] < 0 || curve[2] > 1) return void 0;
  return curve.map((n) => Math.round(n * 1e3) / 1e3);
}

// src/tools/ext/assets.ts
var fs6 = __toESM(require("node:fs"), 1);
var path7 = __toESM(require("node:path"), 1);

// node_modules/zod/v3/external.js
var external_exports = {};
__export(external_exports, {
  BRAND: () => BRAND,
  DIRTY: () => DIRTY,
  EMPTY_PATH: () => EMPTY_PATH,
  INVALID: () => INVALID,
  NEVER: () => NEVER,
  OK: () => OK,
  ParseStatus: () => ParseStatus,
  Schema: () => ZodType,
  ZodAny: () => ZodAny,
  ZodArray: () => ZodArray,
  ZodBigInt: () => ZodBigInt,
  ZodBoolean: () => ZodBoolean,
  ZodBranded: () => ZodBranded,
  ZodCatch: () => ZodCatch,
  ZodDate: () => ZodDate,
  ZodDefault: () => ZodDefault,
  ZodDiscriminatedUnion: () => ZodDiscriminatedUnion,
  ZodEffects: () => ZodEffects,
  ZodEnum: () => ZodEnum,
  ZodError: () => ZodError,
  ZodFirstPartyTypeKind: () => ZodFirstPartyTypeKind,
  ZodFunction: () => ZodFunction,
  ZodIntersection: () => ZodIntersection,
  ZodIssueCode: () => ZodIssueCode,
  ZodLazy: () => ZodLazy,
  ZodLiteral: () => ZodLiteral,
  ZodMap: () => ZodMap,
  ZodNaN: () => ZodNaN,
  ZodNativeEnum: () => ZodNativeEnum,
  ZodNever: () => ZodNever,
  ZodNull: () => ZodNull,
  ZodNullable: () => ZodNullable,
  ZodNumber: () => ZodNumber,
  ZodObject: () => ZodObject,
  ZodOptional: () => ZodOptional,
  ZodParsedType: () => ZodParsedType,
  ZodPipeline: () => ZodPipeline,
  ZodPromise: () => ZodPromise,
  ZodReadonly: () => ZodReadonly,
  ZodRecord: () => ZodRecord,
  ZodSchema: () => ZodType,
  ZodSet: () => ZodSet,
  ZodString: () => ZodString,
  ZodSymbol: () => ZodSymbol,
  ZodTransformer: () => ZodEffects,
  ZodTuple: () => ZodTuple,
  ZodType: () => ZodType,
  ZodUndefined: () => ZodUndefined,
  ZodUnion: () => ZodUnion,
  ZodUnknown: () => ZodUnknown,
  ZodVoid: () => ZodVoid,
  addIssueToContext: () => addIssueToContext,
  any: () => anyType,
  array: () => arrayType,
  bigint: () => bigIntType,
  boolean: () => booleanType,
  coerce: () => coerce,
  custom: () => custom,
  date: () => dateType,
  datetimeRegex: () => datetimeRegex,
  defaultErrorMap: () => en_default,
  discriminatedUnion: () => discriminatedUnionType,
  effect: () => effectsType,
  enum: () => enumType,
  function: () => functionType,
  getErrorMap: () => getErrorMap,
  getParsedType: () => getParsedType,
  instanceof: () => instanceOfType,
  intersection: () => intersectionType,
  isAborted: () => isAborted,
  isAsync: () => isAsync,
  isDirty: () => isDirty,
  isValid: () => isValid,
  late: () => late,
  lazy: () => lazyType,
  literal: () => literalType,
  makeIssue: () => makeIssue,
  map: () => mapType,
  nan: () => nanType,
  nativeEnum: () => nativeEnumType,
  never: () => neverType,
  null: () => nullType,
  nullable: () => nullableType,
  number: () => numberType,
  object: () => objectType,
  objectUtil: () => objectUtil,
  oboolean: () => oboolean,
  onumber: () => onumber,
  optional: () => optionalType,
  ostring: () => ostring,
  pipeline: () => pipelineType,
  preprocess: () => preprocessType,
  promise: () => promiseType,
  quotelessJson: () => quotelessJson,
  record: () => recordType,
  set: () => setType,
  setErrorMap: () => setErrorMap,
  strictObject: () => strictObjectType,
  string: () => stringType,
  symbol: () => symbolType,
  transformer: () => effectsType,
  tuple: () => tupleType,
  undefined: () => undefinedType,
  union: () => unionType,
  unknown: () => unknownType,
  util: () => util,
  void: () => voidType
});

// node_modules/zod/v3/helpers/util.js
var util;
(function(util2) {
  util2.assertEqual = (_) => {
  };
  function assertIs(_arg) {
  }
  util2.assertIs = assertIs;
  function assertNever(_x) {
    throw new Error();
  }
  util2.assertNever = assertNever;
  util2.arrayToEnum = (items) => {
    const obj = {};
    for (const item of items) {
      obj[item] = item;
    }
    return obj;
  };
  util2.getValidEnumValues = (obj) => {
    const validKeys = util2.objectKeys(obj).filter((k) => typeof obj[obj[k]] !== "number");
    const filtered = {};
    for (const k of validKeys) {
      filtered[k] = obj[k];
    }
    return util2.objectValues(filtered);
  };
  util2.objectValues = (obj) => {
    return util2.objectKeys(obj).map(function(e) {
      return obj[e];
    });
  };
  util2.objectKeys = typeof Object.keys === "function" ? (obj) => Object.keys(obj) : (object) => {
    const keys = [];
    for (const key in object) {
      if (Object.prototype.hasOwnProperty.call(object, key)) {
        keys.push(key);
      }
    }
    return keys;
  };
  util2.find = (arr, checker) => {
    for (const item of arr) {
      if (checker(item))
        return item;
    }
    return void 0;
  };
  util2.isInteger = typeof Number.isInteger === "function" ? (val) => Number.isInteger(val) : (val) => typeof val === "number" && Number.isFinite(val) && Math.floor(val) === val;
  function joinValues(array, separator = " | ") {
    return array.map((val) => typeof val === "string" ? `'${val}'` : val).join(separator);
  }
  util2.joinValues = joinValues;
  util2.jsonStringifyReplacer = (_, value) => {
    if (typeof value === "bigint") {
      return value.toString();
    }
    return value;
  };
})(util || (util = {}));
var objectUtil;
(function(objectUtil2) {
  objectUtil2.mergeShapes = (first, second) => {
    return {
      ...first,
      ...second
      // second overwrites first
    };
  };
})(objectUtil || (objectUtil = {}));
var ZodParsedType = util.arrayToEnum([
  "string",
  "nan",
  "number",
  "integer",
  "float",
  "boolean",
  "date",
  "bigint",
  "symbol",
  "function",
  "undefined",
  "null",
  "array",
  "object",
  "unknown",
  "promise",
  "void",
  "never",
  "map",
  "set"
]);
var getParsedType = (data) => {
  const t = typeof data;
  switch (t) {
    case "undefined":
      return ZodParsedType.undefined;
    case "string":
      return ZodParsedType.string;
    case "number":
      return Number.isNaN(data) ? ZodParsedType.nan : ZodParsedType.number;
    case "boolean":
      return ZodParsedType.boolean;
    case "function":
      return ZodParsedType.function;
    case "bigint":
      return ZodParsedType.bigint;
    case "symbol":
      return ZodParsedType.symbol;
    case "object":
      if (Array.isArray(data)) {
        return ZodParsedType.array;
      }
      if (data === null) {
        return ZodParsedType.null;
      }
      if (data.then && typeof data.then === "function" && data.catch && typeof data.catch === "function") {
        return ZodParsedType.promise;
      }
      if (typeof Map !== "undefined" && data instanceof Map) {
        return ZodParsedType.map;
      }
      if (typeof Set !== "undefined" && data instanceof Set) {
        return ZodParsedType.set;
      }
      if (typeof Date !== "undefined" && data instanceof Date) {
        return ZodParsedType.date;
      }
      return ZodParsedType.object;
    default:
      return ZodParsedType.unknown;
  }
};

// node_modules/zod/v3/ZodError.js
var ZodIssueCode = util.arrayToEnum([
  "invalid_type",
  "invalid_literal",
  "custom",
  "invalid_union",
  "invalid_union_discriminator",
  "invalid_enum_value",
  "unrecognized_keys",
  "invalid_arguments",
  "invalid_return_type",
  "invalid_date",
  "invalid_string",
  "too_small",
  "too_big",
  "invalid_intersection_types",
  "not_multiple_of",
  "not_finite"
]);
var quotelessJson = (obj) => {
  const json = JSON.stringify(obj, null, 2);
  return json.replace(/"([^"]+)":/g, "$1:");
};
var ZodError = class _ZodError extends Error {
  get errors() {
    return this.issues;
  }
  constructor(issues) {
    super();
    this.issues = [];
    this.addIssue = (sub) => {
      this.issues = [...this.issues, sub];
    };
    this.addIssues = (subs = []) => {
      this.issues = [...this.issues, ...subs];
    };
    const actualProto = new.target.prototype;
    if (Object.setPrototypeOf) {
      Object.setPrototypeOf(this, actualProto);
    } else {
      this.__proto__ = actualProto;
    }
    this.name = "ZodError";
    this.issues = issues;
  }
  format(_mapper) {
    const mapper = _mapper || function(issue) {
      return issue.message;
    };
    const fieldErrors = { _errors: [] };
    const processError = (error) => {
      for (const issue of error.issues) {
        if (issue.code === "invalid_union") {
          issue.unionErrors.map(processError);
        } else if (issue.code === "invalid_return_type") {
          processError(issue.returnTypeError);
        } else if (issue.code === "invalid_arguments") {
          processError(issue.argumentsError);
        } else if (issue.path.length === 0) {
          fieldErrors._errors.push(mapper(issue));
        } else {
          let curr = fieldErrors;
          let i = 0;
          while (i < issue.path.length) {
            const el = issue.path[i];
            const terminal = i === issue.path.length - 1;
            if (!terminal) {
              curr[el] = curr[el] || { _errors: [] };
            } else {
              curr[el] = curr[el] || { _errors: [] };
              curr[el]._errors.push(mapper(issue));
            }
            curr = curr[el];
            i++;
          }
        }
      }
    };
    processError(this);
    return fieldErrors;
  }
  static assert(value) {
    if (!(value instanceof _ZodError)) {
      throw new Error(`Not a ZodError: ${value}`);
    }
  }
  toString() {
    return this.message;
  }
  get message() {
    return JSON.stringify(this.issues, util.jsonStringifyReplacer, 2);
  }
  get isEmpty() {
    return this.issues.length === 0;
  }
  flatten(mapper = (issue) => issue.message) {
    const fieldErrors = {};
    const formErrors = [];
    for (const sub of this.issues) {
      if (sub.path.length > 0) {
        const firstEl = sub.path[0];
        fieldErrors[firstEl] = fieldErrors[firstEl] || [];
        fieldErrors[firstEl].push(mapper(sub));
      } else {
        formErrors.push(mapper(sub));
      }
    }
    return { formErrors, fieldErrors };
  }
  get formErrors() {
    return this.flatten();
  }
};
ZodError.create = (issues) => {
  const error = new ZodError(issues);
  return error;
};

// node_modules/zod/v3/locales/en.js
var errorMap = (issue, _ctx) => {
  let message;
  switch (issue.code) {
    case ZodIssueCode.invalid_type:
      if (issue.received === ZodParsedType.undefined) {
        message = "Required";
      } else {
        message = `Expected ${issue.expected}, received ${issue.received}`;
      }
      break;
    case ZodIssueCode.invalid_literal:
      message = `Invalid literal value, expected ${JSON.stringify(issue.expected, util.jsonStringifyReplacer)}`;
      break;
    case ZodIssueCode.unrecognized_keys:
      message = `Unrecognized key(s) in object: ${util.joinValues(issue.keys, ", ")}`;
      break;
    case ZodIssueCode.invalid_union:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_union_discriminator:
      message = `Invalid discriminator value. Expected ${util.joinValues(issue.options)}`;
      break;
    case ZodIssueCode.invalid_enum_value:
      message = `Invalid enum value. Expected ${util.joinValues(issue.options)}, received '${issue.received}'`;
      break;
    case ZodIssueCode.invalid_arguments:
      message = `Invalid function arguments`;
      break;
    case ZodIssueCode.invalid_return_type:
      message = `Invalid function return type`;
      break;
    case ZodIssueCode.invalid_date:
      message = `Invalid date`;
      break;
    case ZodIssueCode.invalid_string:
      if (typeof issue.validation === "object") {
        if ("includes" in issue.validation) {
          message = `Invalid input: must include "${issue.validation.includes}"`;
          if (typeof issue.validation.position === "number") {
            message = `${message} at one or more positions greater than or equal to ${issue.validation.position}`;
          }
        } else if ("startsWith" in issue.validation) {
          message = `Invalid input: must start with "${issue.validation.startsWith}"`;
        } else if ("endsWith" in issue.validation) {
          message = `Invalid input: must end with "${issue.validation.endsWith}"`;
        } else {
          util.assertNever(issue.validation);
        }
      } else if (issue.validation !== "regex") {
        message = `Invalid ${issue.validation}`;
      } else {
        message = "Invalid";
      }
      break;
    case ZodIssueCode.too_small:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `more than`} ${issue.minimum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `over`} ${issue.minimum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "bigint")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${new Date(Number(issue.minimum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.too_big:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `less than`} ${issue.maximum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `under`} ${issue.maximum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "bigint")
        message = `BigInt must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly` : issue.inclusive ? `smaller than or equal to` : `smaller than`} ${new Date(Number(issue.maximum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.custom:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_intersection_types:
      message = `Intersection results could not be merged`;
      break;
    case ZodIssueCode.not_multiple_of:
      message = `Number must be a multiple of ${issue.multipleOf}`;
      break;
    case ZodIssueCode.not_finite:
      message = "Number must be finite";
      break;
    default:
      message = _ctx.defaultError;
      util.assertNever(issue);
  }
  return { message };
};
var en_default = errorMap;

// node_modules/zod/v3/errors.js
var overrideErrorMap = en_default;
function setErrorMap(map) {
  overrideErrorMap = map;
}
function getErrorMap() {
  return overrideErrorMap;
}

// node_modules/zod/v3/helpers/parseUtil.js
var makeIssue = (params) => {
  const { data, path: path23, errorMaps, issueData } = params;
  const fullPath = [...path23, ...issueData.path || []];
  const fullIssue = {
    ...issueData,
    path: fullPath
  };
  if (issueData.message !== void 0) {
    return {
      ...issueData,
      path: fullPath,
      message: issueData.message
    };
  }
  let errorMessage = "";
  const maps = errorMaps.filter((m) => !!m).slice().reverse();
  for (const map of maps) {
    errorMessage = map(fullIssue, { data, defaultError: errorMessage }).message;
  }
  return {
    ...issueData,
    path: fullPath,
    message: errorMessage
  };
};
var EMPTY_PATH = [];
function addIssueToContext(ctx, issueData) {
  const overrideMap = getErrorMap();
  const issue = makeIssue({
    issueData,
    data: ctx.data,
    path: ctx.path,
    errorMaps: [
      ctx.common.contextualErrorMap,
      // contextual error map is first priority
      ctx.schemaErrorMap,
      // then schema-bound map if available
      overrideMap,
      // then global override map
      overrideMap === en_default ? void 0 : en_default
      // then global default map
    ].filter((x) => !!x)
  });
  ctx.common.issues.push(issue);
}
var ParseStatus = class _ParseStatus {
  constructor() {
    this.value = "valid";
  }
  dirty() {
    if (this.value === "valid")
      this.value = "dirty";
  }
  abort() {
    if (this.value !== "aborted")
      this.value = "aborted";
  }
  static mergeArray(status, results) {
    const arrayValue = [];
    for (const s of results) {
      if (s.status === "aborted")
        return INVALID;
      if (s.status === "dirty")
        status.dirty();
      arrayValue.push(s.value);
    }
    return { status: status.value, value: arrayValue };
  }
  static async mergeObjectAsync(status, pairs) {
    const syncPairs = [];
    for (const pair of pairs) {
      const key = await pair.key;
      const value = await pair.value;
      syncPairs.push({
        key,
        value
      });
    }
    return _ParseStatus.mergeObjectSync(status, syncPairs);
  }
  static mergeObjectSync(status, pairs) {
    const finalObject = {};
    for (const pair of pairs) {
      const { key, value } = pair;
      if (key.status === "aborted")
        return INVALID;
      if (value.status === "aborted")
        return INVALID;
      if (key.status === "dirty")
        status.dirty();
      if (value.status === "dirty")
        status.dirty();
      if (key.value !== "__proto__" && (typeof value.value !== "undefined" || pair.alwaysSet)) {
        finalObject[key.value] = value.value;
      }
    }
    return { status: status.value, value: finalObject };
  }
};
var INVALID = Object.freeze({
  status: "aborted"
});
var DIRTY = (value) => ({ status: "dirty", value });
var OK = (value) => ({ status: "valid", value });
var isAborted = (x) => x.status === "aborted";
var isDirty = (x) => x.status === "dirty";
var isValid = (x) => x.status === "valid";
var isAsync = (x) => typeof Promise !== "undefined" && x instanceof Promise;

// node_modules/zod/v3/helpers/errorUtil.js
var errorUtil;
(function(errorUtil2) {
  errorUtil2.errToObj = (message) => typeof message === "string" ? { message } : message || {};
  errorUtil2.toString = (message) => typeof message === "string" ? message : message?.message;
})(errorUtil || (errorUtil = {}));

// node_modules/zod/v3/types.js
var ParseInputLazyPath = class {
  constructor(parent, value, path23, key) {
    this._cachedPath = [];
    this.parent = parent;
    this.data = value;
    this._path = path23;
    this._key = key;
  }
  get path() {
    if (!this._cachedPath.length) {
      if (Array.isArray(this._key)) {
        this._cachedPath.push(...this._path, ...this._key);
      } else {
        this._cachedPath.push(...this._path, this._key);
      }
    }
    return this._cachedPath;
  }
};
var handleResult = (ctx, result) => {
  if (isValid(result)) {
    return { success: true, data: result.value };
  } else {
    if (!ctx.common.issues.length) {
      throw new Error("Validation failed but no issues detected.");
    }
    return {
      success: false,
      get error() {
        if (this._error)
          return this._error;
        const error = new ZodError(ctx.common.issues);
        this._error = error;
        return this._error;
      }
    };
  }
};
function processCreateParams(params) {
  if (!params)
    return {};
  const { errorMap: errorMap2, invalid_type_error, required_error, description } = params;
  if (errorMap2 && (invalid_type_error || required_error)) {
    throw new Error(`Can't use "invalid_type_error" or "required_error" in conjunction with custom error map.`);
  }
  if (errorMap2)
    return { errorMap: errorMap2, description };
  const customMap = (iss, ctx) => {
    const { message } = params;
    if (iss.code === "invalid_enum_value") {
      return { message: message ?? ctx.defaultError };
    }
    if (typeof ctx.data === "undefined") {
      return { message: message ?? required_error ?? ctx.defaultError };
    }
    if (iss.code !== "invalid_type")
      return { message: ctx.defaultError };
    return { message: message ?? invalid_type_error ?? ctx.defaultError };
  };
  return { errorMap: customMap, description };
}
var ZodType = class {
  get description() {
    return this._def.description;
  }
  _getType(input) {
    return getParsedType(input.data);
  }
  _getOrReturnCtx(input, ctx) {
    return ctx || {
      common: input.parent.common,
      data: input.data,
      parsedType: getParsedType(input.data),
      schemaErrorMap: this._def.errorMap,
      path: input.path,
      parent: input.parent
    };
  }
  _processInputParams(input) {
    return {
      status: new ParseStatus(),
      ctx: {
        common: input.parent.common,
        data: input.data,
        parsedType: getParsedType(input.data),
        schemaErrorMap: this._def.errorMap,
        path: input.path,
        parent: input.parent
      }
    };
  }
  _parseSync(input) {
    const result = this._parse(input);
    if (isAsync(result)) {
      throw new Error("Synchronous parse encountered promise.");
    }
    return result;
  }
  _parseAsync(input) {
    const result = this._parse(input);
    return Promise.resolve(result);
  }
  parse(data, params) {
    const result = this.safeParse(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  safeParse(data, params) {
    const ctx = {
      common: {
        issues: [],
        async: params?.async ?? false,
        contextualErrorMap: params?.errorMap
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const result = this._parseSync({ data, path: ctx.path, parent: ctx });
    return handleResult(ctx, result);
  }
  "~validate"(data) {
    const ctx = {
      common: {
        issues: [],
        async: !!this["~standard"].async
      },
      path: [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    if (!this["~standard"].async) {
      try {
        const result = this._parseSync({ data, path: [], parent: ctx });
        return isValid(result) ? {
          value: result.value
        } : {
          issues: ctx.common.issues
        };
      } catch (err) {
        if (err?.message?.toLowerCase()?.includes("encountered")) {
          this["~standard"].async = true;
        }
        ctx.common = {
          issues: [],
          async: true
        };
      }
    }
    return this._parseAsync({ data, path: [], parent: ctx }).then((result) => isValid(result) ? {
      value: result.value
    } : {
      issues: ctx.common.issues
    });
  }
  async parseAsync(data, params) {
    const result = await this.safeParseAsync(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  async safeParseAsync(data, params) {
    const ctx = {
      common: {
        issues: [],
        contextualErrorMap: params?.errorMap,
        async: true
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const maybeAsyncResult = this._parse({ data, path: ctx.path, parent: ctx });
    const result = await (isAsync(maybeAsyncResult) ? maybeAsyncResult : Promise.resolve(maybeAsyncResult));
    return handleResult(ctx, result);
  }
  refine(check, message) {
    const getIssueProperties = (val) => {
      if (typeof message === "string" || typeof message === "undefined") {
        return { message };
      } else if (typeof message === "function") {
        return message(val);
      } else {
        return message;
      }
    };
    return this._refinement((val, ctx) => {
      const result = check(val);
      const setError = () => ctx.addIssue({
        code: ZodIssueCode.custom,
        ...getIssueProperties(val)
      });
      if (typeof Promise !== "undefined" && result instanceof Promise) {
        return result.then((data) => {
          if (!data) {
            setError();
            return false;
          } else {
            return true;
          }
        });
      }
      if (!result) {
        setError();
        return false;
      } else {
        return true;
      }
    });
  }
  refinement(check, refinementData) {
    return this._refinement((val, ctx) => {
      if (!check(val)) {
        ctx.addIssue(typeof refinementData === "function" ? refinementData(val, ctx) : refinementData);
        return false;
      } else {
        return true;
      }
    });
  }
  _refinement(refinement) {
    return new ZodEffects({
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "refinement", refinement }
    });
  }
  superRefine(refinement) {
    return this._refinement(refinement);
  }
  constructor(def) {
    this.spa = this.safeParseAsync;
    this._def = def;
    this.parse = this.parse.bind(this);
    this.safeParse = this.safeParse.bind(this);
    this.parseAsync = this.parseAsync.bind(this);
    this.safeParseAsync = this.safeParseAsync.bind(this);
    this.spa = this.spa.bind(this);
    this.refine = this.refine.bind(this);
    this.refinement = this.refinement.bind(this);
    this.superRefine = this.superRefine.bind(this);
    this.optional = this.optional.bind(this);
    this.nullable = this.nullable.bind(this);
    this.nullish = this.nullish.bind(this);
    this.array = this.array.bind(this);
    this.promise = this.promise.bind(this);
    this.or = this.or.bind(this);
    this.and = this.and.bind(this);
    this.transform = this.transform.bind(this);
    this.brand = this.brand.bind(this);
    this.default = this.default.bind(this);
    this.catch = this.catch.bind(this);
    this.describe = this.describe.bind(this);
    this.pipe = this.pipe.bind(this);
    this.readonly = this.readonly.bind(this);
    this.isNullable = this.isNullable.bind(this);
    this.isOptional = this.isOptional.bind(this);
    this["~standard"] = {
      version: 1,
      vendor: "zod",
      validate: (data) => this["~validate"](data)
    };
  }
  optional() {
    return ZodOptional.create(this, this._def);
  }
  nullable() {
    return ZodNullable.create(this, this._def);
  }
  nullish() {
    return this.nullable().optional();
  }
  array() {
    return ZodArray.create(this);
  }
  promise() {
    return ZodPromise.create(this, this._def);
  }
  or(option) {
    return ZodUnion.create([this, option], this._def);
  }
  and(incoming) {
    return ZodIntersection.create(this, incoming, this._def);
  }
  transform(transform) {
    return new ZodEffects({
      ...processCreateParams(this._def),
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "transform", transform }
    });
  }
  default(def) {
    const defaultValueFunc = typeof def === "function" ? def : () => def;
    return new ZodDefault({
      ...processCreateParams(this._def),
      innerType: this,
      defaultValue: defaultValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodDefault
    });
  }
  brand() {
    return new ZodBranded({
      typeName: ZodFirstPartyTypeKind.ZodBranded,
      type: this,
      ...processCreateParams(this._def)
    });
  }
  catch(def) {
    const catchValueFunc = typeof def === "function" ? def : () => def;
    return new ZodCatch({
      ...processCreateParams(this._def),
      innerType: this,
      catchValue: catchValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodCatch
    });
  }
  describe(description) {
    const This = this.constructor;
    return new This({
      ...this._def,
      description
    });
  }
  pipe(target) {
    return ZodPipeline.create(this, target);
  }
  readonly() {
    return ZodReadonly.create(this);
  }
  isOptional() {
    return this.safeParse(void 0).success;
  }
  isNullable() {
    return this.safeParse(null).success;
  }
};
var cuidRegex = /^c[^\s-]{8,}$/i;
var cuid2Regex = /^[0-9a-z]+$/;
var ulidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
var uuidRegex = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;
var nanoidRegex = /^[a-z0-9_-]{21}$/i;
var jwtRegex = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/;
var durationRegex = /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;
var emailRegex = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;
var _emojiRegex = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
var emojiRegex;
var ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
var ipv4CidrRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/(3[0-2]|[12]?[0-9])$/;
var ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
var ipv6CidrRegex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
var base64Regex = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;
var base64urlRegex = /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$/;
var dateRegexSource = `((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))`;
var dateRegex = new RegExp(`^${dateRegexSource}$`);
function timeRegexSource(args) {
  let secondsRegexSource = `[0-5]\\d`;
  if (args.precision) {
    secondsRegexSource = `${secondsRegexSource}\\.\\d{${args.precision}}`;
  } else if (args.precision == null) {
    secondsRegexSource = `${secondsRegexSource}(\\.\\d+)?`;
  }
  const secondsQuantifier = args.precision ? "+" : "?";
  return `([01]\\d|2[0-3]):[0-5]\\d(:${secondsRegexSource})${secondsQuantifier}`;
}
function timeRegex(args) {
  return new RegExp(`^${timeRegexSource(args)}$`);
}
function datetimeRegex(args) {
  let regex = `${dateRegexSource}T${timeRegexSource(args)}`;
  const opts = [];
  opts.push(args.local ? `Z?` : `Z`);
  if (args.offset)
    opts.push(`([+-]\\d{2}:?\\d{2})`);
  regex = `${regex}(${opts.join("|")})`;
  return new RegExp(`^${regex}$`);
}
function isValidIP(ip, version) {
  if ((version === "v4" || !version) && ipv4Regex.test(ip)) {
    return true;
  }
  if ((version === "v6" || !version) && ipv6Regex.test(ip)) {
    return true;
  }
  return false;
}
function isValidJWT(jwt, alg) {
  if (!jwtRegex.test(jwt))
    return false;
  try {
    const [header] = jwt.split(".");
    if (!header)
      return false;
    const base64 = header.replace(/-/g, "+").replace(/_/g, "/").padEnd(header.length + (4 - header.length % 4) % 4, "=");
    const decoded = JSON.parse(atob(base64));
    if (typeof decoded !== "object" || decoded === null)
      return false;
    if ("typ" in decoded && decoded?.typ !== "JWT")
      return false;
    if (!decoded.alg)
      return false;
    if (alg && decoded.alg !== alg)
      return false;
    return true;
  } catch {
    return false;
  }
}
function isValidCidr(ip, version) {
  if ((version === "v4" || !version) && ipv4CidrRegex.test(ip)) {
    return true;
  }
  if ((version === "v6" || !version) && ipv6CidrRegex.test(ip)) {
    return true;
  }
  return false;
}
var ZodString = class _ZodString extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = String(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.string) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.string,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = void 0;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.length < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.length > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "length") {
        const tooBig = input.data.length > check.value;
        const tooSmall = input.data.length < check.value;
        if (tooBig || tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          if (tooBig) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_big,
              maximum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          } else if (tooSmall) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_small,
              minimum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          }
          status.dirty();
        }
      } else if (check.kind === "email") {
        if (!emailRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "email",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "emoji") {
        if (!emojiRegex) {
          emojiRegex = new RegExp(_emojiRegex, "u");
        }
        if (!emojiRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "emoji",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "uuid") {
        if (!uuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "uuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "nanoid") {
        if (!nanoidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "nanoid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid") {
        if (!cuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid2") {
        if (!cuid2Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid2",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ulid") {
        if (!ulidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ulid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "url") {
        try {
          new URL(input.data);
        } catch {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "regex") {
        check.regex.lastIndex = 0;
        const testResult = check.regex.test(input.data);
        if (!testResult) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "regex",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "trim") {
        input.data = input.data.trim();
      } else if (check.kind === "includes") {
        if (!input.data.includes(check.value, check.position)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { includes: check.value, position: check.position },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "toLowerCase") {
        input.data = input.data.toLowerCase();
      } else if (check.kind === "toUpperCase") {
        input.data = input.data.toUpperCase();
      } else if (check.kind === "startsWith") {
        if (!input.data.startsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { startsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "endsWith") {
        if (!input.data.endsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { endsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "datetime") {
        const regex = datetimeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "datetime",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "date") {
        const regex = dateRegex;
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "date",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "time") {
        const regex = timeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "time",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "duration") {
        if (!durationRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "duration",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ip") {
        if (!isValidIP(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ip",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "jwt") {
        if (!isValidJWT(input.data, check.alg)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "jwt",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cidr") {
        if (!isValidCidr(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cidr",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64") {
        if (!base64Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64url") {
        if (!base64urlRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _regex(regex, validation, message) {
    return this.refinement((data) => regex.test(data), {
      validation,
      code: ZodIssueCode.invalid_string,
      ...errorUtil.errToObj(message)
    });
  }
  _addCheck(check) {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  email(message) {
    return this._addCheck({ kind: "email", ...errorUtil.errToObj(message) });
  }
  url(message) {
    return this._addCheck({ kind: "url", ...errorUtil.errToObj(message) });
  }
  emoji(message) {
    return this._addCheck({ kind: "emoji", ...errorUtil.errToObj(message) });
  }
  uuid(message) {
    return this._addCheck({ kind: "uuid", ...errorUtil.errToObj(message) });
  }
  nanoid(message) {
    return this._addCheck({ kind: "nanoid", ...errorUtil.errToObj(message) });
  }
  cuid(message) {
    return this._addCheck({ kind: "cuid", ...errorUtil.errToObj(message) });
  }
  cuid2(message) {
    return this._addCheck({ kind: "cuid2", ...errorUtil.errToObj(message) });
  }
  ulid(message) {
    return this._addCheck({ kind: "ulid", ...errorUtil.errToObj(message) });
  }
  base64(message) {
    return this._addCheck({ kind: "base64", ...errorUtil.errToObj(message) });
  }
  base64url(message) {
    return this._addCheck({
      kind: "base64url",
      ...errorUtil.errToObj(message)
    });
  }
  jwt(options) {
    return this._addCheck({ kind: "jwt", ...errorUtil.errToObj(options) });
  }
  ip(options) {
    return this._addCheck({ kind: "ip", ...errorUtil.errToObj(options) });
  }
  cidr(options) {
    return this._addCheck({ kind: "cidr", ...errorUtil.errToObj(options) });
  }
  datetime(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "datetime",
        precision: null,
        offset: false,
        local: false,
        message: options
      });
    }
    return this._addCheck({
      kind: "datetime",
      precision: typeof options?.precision === "undefined" ? null : options?.precision,
      offset: options?.offset ?? false,
      local: options?.local ?? false,
      ...errorUtil.errToObj(options?.message)
    });
  }
  date(message) {
    return this._addCheck({ kind: "date", message });
  }
  time(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "time",
        precision: null,
        message: options
      });
    }
    return this._addCheck({
      kind: "time",
      precision: typeof options?.precision === "undefined" ? null : options?.precision,
      ...errorUtil.errToObj(options?.message)
    });
  }
  duration(message) {
    return this._addCheck({ kind: "duration", ...errorUtil.errToObj(message) });
  }
  regex(regex, message) {
    return this._addCheck({
      kind: "regex",
      regex,
      ...errorUtil.errToObj(message)
    });
  }
  includes(value, options) {
    return this._addCheck({
      kind: "includes",
      value,
      position: options?.position,
      ...errorUtil.errToObj(options?.message)
    });
  }
  startsWith(value, message) {
    return this._addCheck({
      kind: "startsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  endsWith(value, message) {
    return this._addCheck({
      kind: "endsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  min(minLength, message) {
    return this._addCheck({
      kind: "min",
      value: minLength,
      ...errorUtil.errToObj(message)
    });
  }
  max(maxLength, message) {
    return this._addCheck({
      kind: "max",
      value: maxLength,
      ...errorUtil.errToObj(message)
    });
  }
  length(len, message) {
    return this._addCheck({
      kind: "length",
      value: len,
      ...errorUtil.errToObj(message)
    });
  }
  /**
   * Equivalent to `.min(1)`
   */
  nonempty(message) {
    return this.min(1, errorUtil.errToObj(message));
  }
  trim() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "trim" }]
    });
  }
  toLowerCase() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toLowerCase" }]
    });
  }
  toUpperCase() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toUpperCase" }]
    });
  }
  get isDatetime() {
    return !!this._def.checks.find((ch) => ch.kind === "datetime");
  }
  get isDate() {
    return !!this._def.checks.find((ch) => ch.kind === "date");
  }
  get isTime() {
    return !!this._def.checks.find((ch) => ch.kind === "time");
  }
  get isDuration() {
    return !!this._def.checks.find((ch) => ch.kind === "duration");
  }
  get isEmail() {
    return !!this._def.checks.find((ch) => ch.kind === "email");
  }
  get isURL() {
    return !!this._def.checks.find((ch) => ch.kind === "url");
  }
  get isEmoji() {
    return !!this._def.checks.find((ch) => ch.kind === "emoji");
  }
  get isUUID() {
    return !!this._def.checks.find((ch) => ch.kind === "uuid");
  }
  get isNANOID() {
    return !!this._def.checks.find((ch) => ch.kind === "nanoid");
  }
  get isCUID() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid");
  }
  get isCUID2() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid2");
  }
  get isULID() {
    return !!this._def.checks.find((ch) => ch.kind === "ulid");
  }
  get isIP() {
    return !!this._def.checks.find((ch) => ch.kind === "ip");
  }
  get isCIDR() {
    return !!this._def.checks.find((ch) => ch.kind === "cidr");
  }
  get isBase64() {
    return !!this._def.checks.find((ch) => ch.kind === "base64");
  }
  get isBase64url() {
    return !!this._def.checks.find((ch) => ch.kind === "base64url");
  }
  get minLength() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxLength() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
};
ZodString.create = (params) => {
  return new ZodString({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodString,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params)
  });
};
function floatSafeRemainder(val, step) {
  const valDecCount = (val.toString().split(".")[1] || "").length;
  const stepDecCount = (step.toString().split(".")[1] || "").length;
  const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
  const valInt = Number.parseInt(val.toFixed(decCount).replace(".", ""));
  const stepInt = Number.parseInt(step.toFixed(decCount).replace(".", ""));
  return valInt % stepInt / 10 ** decCount;
}
var ZodNumber = class _ZodNumber extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
    this.step = this.multipleOf;
  }
  _parse(input) {
    if (this._def.coerce) {
      input.data = Number(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.number) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.number,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    let ctx = void 0;
    const status = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === "int") {
        if (!util.isInteger(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_type,
            expected: "integer",
            received: "float",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (floatSafeRemainder(input.data, check.value) !== 0) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "finite") {
        if (!Number.isFinite(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_finite,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new _ZodNumber({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new _ZodNumber({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  int(message) {
    return this._addCheck({
      kind: "int",
      message: errorUtil.toString(message)
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  finite(message) {
    return this._addCheck({
      kind: "finite",
      message: errorUtil.toString(message)
    });
  }
  safe(message) {
    return this._addCheck({
      kind: "min",
      inclusive: true,
      value: Number.MIN_SAFE_INTEGER,
      message: errorUtil.toString(message)
    })._addCheck({
      kind: "max",
      inclusive: true,
      value: Number.MAX_SAFE_INTEGER,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
  get isInt() {
    return !!this._def.checks.find((ch) => ch.kind === "int" || ch.kind === "multipleOf" && util.isInteger(ch.value));
  }
  get isFinite() {
    let max = null;
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "finite" || ch.kind === "int" || ch.kind === "multipleOf") {
        return true;
      } else if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      } else if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return Number.isFinite(min) && Number.isFinite(max);
  }
};
ZodNumber.create = (params) => {
  return new ZodNumber({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodNumber,
    coerce: params?.coerce || false,
    ...processCreateParams(params)
  });
};
var ZodBigInt = class _ZodBigInt extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
  }
  _parse(input) {
    if (this._def.coerce) {
      try {
        input.data = BigInt(input.data);
      } catch {
        return this._getInvalidInput(input);
      }
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.bigint) {
      return this._getInvalidInput(input);
    }
    let ctx = void 0;
    const status = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            type: "bigint",
            minimum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            type: "bigint",
            maximum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (input.data % check.value !== BigInt(0)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _getInvalidInput(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.bigint,
      received: ctx.parsedType
    });
    return INVALID;
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new _ZodBigInt({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new _ZodBigInt({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
};
ZodBigInt.create = (params) => {
  return new ZodBigInt({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodBigInt,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params)
  });
};
var ZodBoolean = class extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = Boolean(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.boolean) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.boolean,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodBoolean.create = (params) => {
  return new ZodBoolean({
    typeName: ZodFirstPartyTypeKind.ZodBoolean,
    coerce: params?.coerce || false,
    ...processCreateParams(params)
  });
};
var ZodDate = class _ZodDate extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = new Date(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.date) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.date,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    if (Number.isNaN(input.data.getTime())) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_date
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = void 0;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.getTime() < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            message: check.message,
            inclusive: true,
            exact: false,
            minimum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.getTime() > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            message: check.message,
            inclusive: true,
            exact: false,
            maximum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return {
      status: status.value,
      value: new Date(input.data.getTime())
    };
  }
  _addCheck(check) {
    return new _ZodDate({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  min(minDate, message) {
    return this._addCheck({
      kind: "min",
      value: minDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  max(maxDate, message) {
    return this._addCheck({
      kind: "max",
      value: maxDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  get minDate() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min != null ? new Date(min) : null;
  }
  get maxDate() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max != null ? new Date(max) : null;
  }
};
ZodDate.create = (params) => {
  return new ZodDate({
    checks: [],
    coerce: params?.coerce || false,
    typeName: ZodFirstPartyTypeKind.ZodDate,
    ...processCreateParams(params)
  });
};
var ZodSymbol = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.symbol) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.symbol,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodSymbol.create = (params) => {
  return new ZodSymbol({
    typeName: ZodFirstPartyTypeKind.ZodSymbol,
    ...processCreateParams(params)
  });
};
var ZodUndefined = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.undefined,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodUndefined.create = (params) => {
  return new ZodUndefined({
    typeName: ZodFirstPartyTypeKind.ZodUndefined,
    ...processCreateParams(params)
  });
};
var ZodNull = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.null) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.null,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodNull.create = (params) => {
  return new ZodNull({
    typeName: ZodFirstPartyTypeKind.ZodNull,
    ...processCreateParams(params)
  });
};
var ZodAny = class extends ZodType {
  constructor() {
    super(...arguments);
    this._any = true;
  }
  _parse(input) {
    return OK(input.data);
  }
};
ZodAny.create = (params) => {
  return new ZodAny({
    typeName: ZodFirstPartyTypeKind.ZodAny,
    ...processCreateParams(params)
  });
};
var ZodUnknown = class extends ZodType {
  constructor() {
    super(...arguments);
    this._unknown = true;
  }
  _parse(input) {
    return OK(input.data);
  }
};
ZodUnknown.create = (params) => {
  return new ZodUnknown({
    typeName: ZodFirstPartyTypeKind.ZodUnknown,
    ...processCreateParams(params)
  });
};
var ZodNever = class extends ZodType {
  _parse(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.never,
      received: ctx.parsedType
    });
    return INVALID;
  }
};
ZodNever.create = (params) => {
  return new ZodNever({
    typeName: ZodFirstPartyTypeKind.ZodNever,
    ...processCreateParams(params)
  });
};
var ZodVoid = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.void,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodVoid.create = (params) => {
  return new ZodVoid({
    typeName: ZodFirstPartyTypeKind.ZodVoid,
    ...processCreateParams(params)
  });
};
var ZodArray = class _ZodArray extends ZodType {
  _parse(input) {
    const { ctx, status } = this._processInputParams(input);
    const def = this._def;
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (def.exactLength !== null) {
      const tooBig = ctx.data.length > def.exactLength.value;
      const tooSmall = ctx.data.length < def.exactLength.value;
      if (tooBig || tooSmall) {
        addIssueToContext(ctx, {
          code: tooBig ? ZodIssueCode.too_big : ZodIssueCode.too_small,
          minimum: tooSmall ? def.exactLength.value : void 0,
          maximum: tooBig ? def.exactLength.value : void 0,
          type: "array",
          inclusive: true,
          exact: true,
          message: def.exactLength.message
        });
        status.dirty();
      }
    }
    if (def.minLength !== null) {
      if (ctx.data.length < def.minLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.minLength.message
        });
        status.dirty();
      }
    }
    if (def.maxLength !== null) {
      if (ctx.data.length > def.maxLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.maxLength.message
        });
        status.dirty();
      }
    }
    if (ctx.common.async) {
      return Promise.all([...ctx.data].map((item, i) => {
        return def.type._parseAsync(new ParseInputLazyPath(ctx, item, ctx.path, i));
      })).then((result2) => {
        return ParseStatus.mergeArray(status, result2);
      });
    }
    const result = [...ctx.data].map((item, i) => {
      return def.type._parseSync(new ParseInputLazyPath(ctx, item, ctx.path, i));
    });
    return ParseStatus.mergeArray(status, result);
  }
  get element() {
    return this._def.type;
  }
  min(minLength, message) {
    return new _ZodArray({
      ...this._def,
      minLength: { value: minLength, message: errorUtil.toString(message) }
    });
  }
  max(maxLength, message) {
    return new _ZodArray({
      ...this._def,
      maxLength: { value: maxLength, message: errorUtil.toString(message) }
    });
  }
  length(len, message) {
    return new _ZodArray({
      ...this._def,
      exactLength: { value: len, message: errorUtil.toString(message) }
    });
  }
  nonempty(message) {
    return this.min(1, message);
  }
};
ZodArray.create = (schema, params) => {
  return new ZodArray({
    type: schema,
    minLength: null,
    maxLength: null,
    exactLength: null,
    typeName: ZodFirstPartyTypeKind.ZodArray,
    ...processCreateParams(params)
  });
};
function deepPartialify(schema) {
  if (schema instanceof ZodObject) {
    const newShape = {};
    for (const key in schema.shape) {
      const fieldSchema = schema.shape[key];
      newShape[key] = ZodOptional.create(deepPartialify(fieldSchema));
    }
    return new ZodObject({
      ...schema._def,
      shape: () => newShape
    });
  } else if (schema instanceof ZodArray) {
    return new ZodArray({
      ...schema._def,
      type: deepPartialify(schema.element)
    });
  } else if (schema instanceof ZodOptional) {
    return ZodOptional.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodNullable) {
    return ZodNullable.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodTuple) {
    return ZodTuple.create(schema.items.map((item) => deepPartialify(item)));
  } else {
    return schema;
  }
}
var ZodObject = class _ZodObject extends ZodType {
  constructor() {
    super(...arguments);
    this._cached = null;
    this.nonstrict = this.passthrough;
    this.augment = this.extend;
  }
  _getCached() {
    if (this._cached !== null)
      return this._cached;
    const shape = this._def.shape();
    const keys = util.objectKeys(shape);
    this._cached = { shape, keys };
    return this._cached;
  }
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.object) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const { status, ctx } = this._processInputParams(input);
    const { shape, keys: shapeKeys } = this._getCached();
    const extraKeys = [];
    if (!(this._def.catchall instanceof ZodNever && this._def.unknownKeys === "strip")) {
      for (const key in ctx.data) {
        if (!shapeKeys.includes(key)) {
          extraKeys.push(key);
        }
      }
    }
    const pairs = [];
    for (const key of shapeKeys) {
      const keyValidator = shape[key];
      const value = ctx.data[key];
      pairs.push({
        key: { status: "valid", value: key },
        value: keyValidator._parse(new ParseInputLazyPath(ctx, value, ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (this._def.catchall instanceof ZodNever) {
      const unknownKeys = this._def.unknownKeys;
      if (unknownKeys === "passthrough") {
        for (const key of extraKeys) {
          pairs.push({
            key: { status: "valid", value: key },
            value: { status: "valid", value: ctx.data[key] }
          });
        }
      } else if (unknownKeys === "strict") {
        if (extraKeys.length > 0) {
          addIssueToContext(ctx, {
            code: ZodIssueCode.unrecognized_keys,
            keys: extraKeys
          });
          status.dirty();
        }
      } else if (unknownKeys === "strip") {
      } else {
        throw new Error(`Internal ZodObject error: invalid unknownKeys value.`);
      }
    } else {
      const catchall = this._def.catchall;
      for (const key of extraKeys) {
        const value = ctx.data[key];
        pairs.push({
          key: { status: "valid", value: key },
          value: catchall._parse(
            new ParseInputLazyPath(ctx, value, ctx.path, key)
            //, ctx.child(key), value, getParsedType(value)
          ),
          alwaysSet: key in ctx.data
        });
      }
    }
    if (ctx.common.async) {
      return Promise.resolve().then(async () => {
        const syncPairs = [];
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          syncPairs.push({
            key,
            value,
            alwaysSet: pair.alwaysSet
          });
        }
        return syncPairs;
      }).then((syncPairs) => {
        return ParseStatus.mergeObjectSync(status, syncPairs);
      });
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get shape() {
    return this._def.shape();
  }
  strict(message) {
    errorUtil.errToObj;
    return new _ZodObject({
      ...this._def,
      unknownKeys: "strict",
      ...message !== void 0 ? {
        errorMap: (issue, ctx) => {
          const defaultError = this._def.errorMap?.(issue, ctx).message ?? ctx.defaultError;
          if (issue.code === "unrecognized_keys")
            return {
              message: errorUtil.errToObj(message).message ?? defaultError
            };
          return {
            message: defaultError
          };
        }
      } : {}
    });
  }
  strip() {
    return new _ZodObject({
      ...this._def,
      unknownKeys: "strip"
    });
  }
  passthrough() {
    return new _ZodObject({
      ...this._def,
      unknownKeys: "passthrough"
    });
  }
  // const AugmentFactory =
  //   <Def extends ZodObjectDef>(def: Def) =>
  //   <Augmentation extends ZodRawShape>(
  //     augmentation: Augmentation
  //   ): ZodObject<
  //     extendShape<ReturnType<Def["shape"]>, Augmentation>,
  //     Def["unknownKeys"],
  //     Def["catchall"]
  //   > => {
  //     return new ZodObject({
  //       ...def,
  //       shape: () => ({
  //         ...def.shape(),
  //         ...augmentation,
  //       }),
  //     }) as any;
  //   };
  extend(augmentation) {
    return new _ZodObject({
      ...this._def,
      shape: () => ({
        ...this._def.shape(),
        ...augmentation
      })
    });
  }
  /**
   * Prior to zod@1.0.12 there was a bug in the
   * inferred type of merged objects. Please
   * upgrade if you are experiencing issues.
   */
  merge(merging) {
    const merged = new _ZodObject({
      unknownKeys: merging._def.unknownKeys,
      catchall: merging._def.catchall,
      shape: () => ({
        ...this._def.shape(),
        ...merging._def.shape()
      }),
      typeName: ZodFirstPartyTypeKind.ZodObject
    });
    return merged;
  }
  // merge<
  //   Incoming extends AnyZodObject,
  //   Augmentation extends Incoming["shape"],
  //   NewOutput extends {
  //     [k in keyof Augmentation | keyof Output]: k extends keyof Augmentation
  //       ? Augmentation[k]["_output"]
  //       : k extends keyof Output
  //       ? Output[k]
  //       : never;
  //   },
  //   NewInput extends {
  //     [k in keyof Augmentation | keyof Input]: k extends keyof Augmentation
  //       ? Augmentation[k]["_input"]
  //       : k extends keyof Input
  //       ? Input[k]
  //       : never;
  //   }
  // >(
  //   merging: Incoming
  // ): ZodObject<
  //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
  //   Incoming["_def"]["unknownKeys"],
  //   Incoming["_def"]["catchall"],
  //   NewOutput,
  //   NewInput
  // > {
  //   const merged: any = new ZodObject({
  //     unknownKeys: merging._def.unknownKeys,
  //     catchall: merging._def.catchall,
  //     shape: () =>
  //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
  //     typeName: ZodFirstPartyTypeKind.ZodObject,
  //   }) as any;
  //   return merged;
  // }
  setKey(key, schema) {
    return this.augment({ [key]: schema });
  }
  // merge<Incoming extends AnyZodObject>(
  //   merging: Incoming
  // ): //ZodObject<T & Incoming["_shape"], UnknownKeys, Catchall> = (merging) => {
  // ZodObject<
  //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
  //   Incoming["_def"]["unknownKeys"],
  //   Incoming["_def"]["catchall"]
  // > {
  //   // const mergedShape = objectUtil.mergeShapes(
  //   //   this._def.shape(),
  //   //   merging._def.shape()
  //   // );
  //   const merged: any = new ZodObject({
  //     unknownKeys: merging._def.unknownKeys,
  //     catchall: merging._def.catchall,
  //     shape: () =>
  //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
  //     typeName: ZodFirstPartyTypeKind.ZodObject,
  //   }) as any;
  //   return merged;
  // }
  catchall(index) {
    return new _ZodObject({
      ...this._def,
      catchall: index
    });
  }
  pick(mask) {
    const shape = {};
    for (const key of util.objectKeys(mask)) {
      if (mask[key] && this.shape[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  omit(mask) {
    const shape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (!mask[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  /**
   * @deprecated
   */
  deepPartial() {
    return deepPartialify(this);
  }
  partial(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      const fieldSchema = this.shape[key];
      if (mask && !mask[key]) {
        newShape[key] = fieldSchema;
      } else {
        newShape[key] = fieldSchema.optional();
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  required(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (mask && !mask[key]) {
        newShape[key] = this.shape[key];
      } else {
        const fieldSchema = this.shape[key];
        let newField = fieldSchema;
        while (newField instanceof ZodOptional) {
          newField = newField._def.innerType;
        }
        newShape[key] = newField;
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  keyof() {
    return createZodEnum(util.objectKeys(this.shape));
  }
};
ZodObject.create = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.strictCreate = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strict",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.lazycreate = (shape, params) => {
  return new ZodObject({
    shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
var ZodUnion = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const options = this._def.options;
    function handleResults(results) {
      for (const result of results) {
        if (result.result.status === "valid") {
          return result.result;
        }
      }
      for (const result of results) {
        if (result.result.status === "dirty") {
          ctx.common.issues.push(...result.ctx.common.issues);
          return result.result;
        }
      }
      const unionErrors = results.map((result) => new ZodError(result.ctx.common.issues));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return Promise.all(options.map(async (option) => {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        return {
          result: await option._parseAsync({
            data: ctx.data,
            path: ctx.path,
            parent: childCtx
          }),
          ctx: childCtx
        };
      })).then(handleResults);
    } else {
      let dirty = void 0;
      const issues = [];
      for (const option of options) {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        const result = option._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: childCtx
        });
        if (result.status === "valid") {
          return result;
        } else if (result.status === "dirty" && !dirty) {
          dirty = { result, ctx: childCtx };
        }
        if (childCtx.common.issues.length) {
          issues.push(childCtx.common.issues);
        }
      }
      if (dirty) {
        ctx.common.issues.push(...dirty.ctx.common.issues);
        return dirty.result;
      }
      const unionErrors = issues.map((issues2) => new ZodError(issues2));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
  }
  get options() {
    return this._def.options;
  }
};
ZodUnion.create = (types, params) => {
  return new ZodUnion({
    options: types,
    typeName: ZodFirstPartyTypeKind.ZodUnion,
    ...processCreateParams(params)
  });
};
var getDiscriminator = (type) => {
  if (type instanceof ZodLazy) {
    return getDiscriminator(type.schema);
  } else if (type instanceof ZodEffects) {
    return getDiscriminator(type.innerType());
  } else if (type instanceof ZodLiteral) {
    return [type.value];
  } else if (type instanceof ZodEnum) {
    return type.options;
  } else if (type instanceof ZodNativeEnum) {
    return util.objectValues(type.enum);
  } else if (type instanceof ZodDefault) {
    return getDiscriminator(type._def.innerType);
  } else if (type instanceof ZodUndefined) {
    return [void 0];
  } else if (type instanceof ZodNull) {
    return [null];
  } else if (type instanceof ZodOptional) {
    return [void 0, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodNullable) {
    return [null, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodBranded) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodReadonly) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodCatch) {
    return getDiscriminator(type._def.innerType);
  } else {
    return [];
  }
};
var ZodDiscriminatedUnion = class _ZodDiscriminatedUnion extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const discriminator = this.discriminator;
    const discriminatorValue = ctx.data[discriminator];
    const option = this.optionsMap.get(discriminatorValue);
    if (!option) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union_discriminator,
        options: Array.from(this.optionsMap.keys()),
        path: [discriminator]
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return option._parseAsync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    } else {
      return option._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    }
  }
  get discriminator() {
    return this._def.discriminator;
  }
  get options() {
    return this._def.options;
  }
  get optionsMap() {
    return this._def.optionsMap;
  }
  /**
   * The constructor of the discriminated union schema. Its behaviour is very similar to that of the normal z.union() constructor.
   * However, it only allows a union of objects, all of which need to share a discriminator property. This property must
   * have a different value for each object in the union.
   * @param discriminator the name of the discriminator property
   * @param types an array of object schemas
   * @param params
   */
  static create(discriminator, options, params) {
    const optionsMap = /* @__PURE__ */ new Map();
    for (const type of options) {
      const discriminatorValues = getDiscriminator(type.shape[discriminator]);
      if (!discriminatorValues.length) {
        throw new Error(`A discriminator value for key \`${discriminator}\` could not be extracted from all schema options`);
      }
      for (const value of discriminatorValues) {
        if (optionsMap.has(value)) {
          throw new Error(`Discriminator property ${String(discriminator)} has duplicate value ${String(value)}`);
        }
        optionsMap.set(value, type);
      }
    }
    return new _ZodDiscriminatedUnion({
      typeName: ZodFirstPartyTypeKind.ZodDiscriminatedUnion,
      discriminator,
      options,
      optionsMap,
      ...processCreateParams(params)
    });
  }
};
function mergeValues(a, b) {
  const aType = getParsedType(a);
  const bType = getParsedType(b);
  if (a === b) {
    return { valid: true, data: a };
  } else if (aType === ZodParsedType.object && bType === ZodParsedType.object) {
    const bKeys = util.objectKeys(b);
    const sharedKeys = util.objectKeys(a).filter((key) => bKeys.indexOf(key) !== -1);
    const newObj = { ...a, ...b };
    for (const key of sharedKeys) {
      const sharedValue = mergeValues(a[key], b[key]);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newObj[key] = sharedValue.data;
    }
    return { valid: true, data: newObj };
  } else if (aType === ZodParsedType.array && bType === ZodParsedType.array) {
    if (a.length !== b.length) {
      return { valid: false };
    }
    const newArray = [];
    for (let index = 0; index < a.length; index++) {
      const itemA = a[index];
      const itemB = b[index];
      const sharedValue = mergeValues(itemA, itemB);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newArray.push(sharedValue.data);
    }
    return { valid: true, data: newArray };
  } else if (aType === ZodParsedType.date && bType === ZodParsedType.date && +a === +b) {
    return { valid: true, data: a };
  } else {
    return { valid: false };
  }
}
var ZodIntersection = class extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const handleParsed = (parsedLeft, parsedRight) => {
      if (isAborted(parsedLeft) || isAborted(parsedRight)) {
        return INVALID;
      }
      const merged = mergeValues(parsedLeft.value, parsedRight.value);
      if (!merged.valid) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_intersection_types
        });
        return INVALID;
      }
      if (isDirty(parsedLeft) || isDirty(parsedRight)) {
        status.dirty();
      }
      return { status: status.value, value: merged.data };
    };
    if (ctx.common.async) {
      return Promise.all([
        this._def.left._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        }),
        this._def.right._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        })
      ]).then(([left, right]) => handleParsed(left, right));
    } else {
      return handleParsed(this._def.left._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }), this._def.right._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }));
    }
  }
};
ZodIntersection.create = (left, right, params) => {
  return new ZodIntersection({
    left,
    right,
    typeName: ZodFirstPartyTypeKind.ZodIntersection,
    ...processCreateParams(params)
  });
};
var ZodTuple = class _ZodTuple extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (ctx.data.length < this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_small,
        minimum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      return INVALID;
    }
    const rest = this._def.rest;
    if (!rest && ctx.data.length > this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_big,
        maximum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      status.dirty();
    }
    const items = [...ctx.data].map((item, itemIndex) => {
      const schema = this._def.items[itemIndex] || this._def.rest;
      if (!schema)
        return null;
      return schema._parse(new ParseInputLazyPath(ctx, item, ctx.path, itemIndex));
    }).filter((x) => !!x);
    if (ctx.common.async) {
      return Promise.all(items).then((results) => {
        return ParseStatus.mergeArray(status, results);
      });
    } else {
      return ParseStatus.mergeArray(status, items);
    }
  }
  get items() {
    return this._def.items;
  }
  rest(rest) {
    return new _ZodTuple({
      ...this._def,
      rest
    });
  }
};
ZodTuple.create = (schemas, params) => {
  if (!Array.isArray(schemas)) {
    throw new Error("You must pass an array of schemas to z.tuple([ ... ])");
  }
  return new ZodTuple({
    items: schemas,
    typeName: ZodFirstPartyTypeKind.ZodTuple,
    rest: null,
    ...processCreateParams(params)
  });
};
var ZodRecord = class _ZodRecord extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const pairs = [];
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    for (const key in ctx.data) {
      pairs.push({
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, key)),
        value: valueType._parse(new ParseInputLazyPath(ctx, ctx.data[key], ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (ctx.common.async) {
      return ParseStatus.mergeObjectAsync(status, pairs);
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get element() {
    return this._def.valueType;
  }
  static create(first, second, third) {
    if (second instanceof ZodType) {
      return new _ZodRecord({
        keyType: first,
        valueType: second,
        typeName: ZodFirstPartyTypeKind.ZodRecord,
        ...processCreateParams(third)
      });
    }
    return new _ZodRecord({
      keyType: ZodString.create(),
      valueType: first,
      typeName: ZodFirstPartyTypeKind.ZodRecord,
      ...processCreateParams(second)
    });
  }
};
var ZodMap = class extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.map) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.map,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    const pairs = [...ctx.data.entries()].map(([key, value], index) => {
      return {
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, [index, "key"])),
        value: valueType._parse(new ParseInputLazyPath(ctx, value, ctx.path, [index, "value"]))
      };
    });
    if (ctx.common.async) {
      const finalMap = /* @__PURE__ */ new Map();
      return Promise.resolve().then(async () => {
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          if (key.status === "aborted" || value.status === "aborted") {
            return INVALID;
          }
          if (key.status === "dirty" || value.status === "dirty") {
            status.dirty();
          }
          finalMap.set(key.value, value.value);
        }
        return { status: status.value, value: finalMap };
      });
    } else {
      const finalMap = /* @__PURE__ */ new Map();
      for (const pair of pairs) {
        const key = pair.key;
        const value = pair.value;
        if (key.status === "aborted" || value.status === "aborted") {
          return INVALID;
        }
        if (key.status === "dirty" || value.status === "dirty") {
          status.dirty();
        }
        finalMap.set(key.value, value.value);
      }
      return { status: status.value, value: finalMap };
    }
  }
};
ZodMap.create = (keyType, valueType, params) => {
  return new ZodMap({
    valueType,
    keyType,
    typeName: ZodFirstPartyTypeKind.ZodMap,
    ...processCreateParams(params)
  });
};
var ZodSet = class _ZodSet extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.set) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.set,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const def = this._def;
    if (def.minSize !== null) {
      if (ctx.data.size < def.minSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.minSize.message
        });
        status.dirty();
      }
    }
    if (def.maxSize !== null) {
      if (ctx.data.size > def.maxSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.maxSize.message
        });
        status.dirty();
      }
    }
    const valueType = this._def.valueType;
    function finalizeSet(elements2) {
      const parsedSet = /* @__PURE__ */ new Set();
      for (const element of elements2) {
        if (element.status === "aborted")
          return INVALID;
        if (element.status === "dirty")
          status.dirty();
        parsedSet.add(element.value);
      }
      return { status: status.value, value: parsedSet };
    }
    const elements = [...ctx.data.values()].map((item, i) => valueType._parse(new ParseInputLazyPath(ctx, item, ctx.path, i)));
    if (ctx.common.async) {
      return Promise.all(elements).then((elements2) => finalizeSet(elements2));
    } else {
      return finalizeSet(elements);
    }
  }
  min(minSize, message) {
    return new _ZodSet({
      ...this._def,
      minSize: { value: minSize, message: errorUtil.toString(message) }
    });
  }
  max(maxSize, message) {
    return new _ZodSet({
      ...this._def,
      maxSize: { value: maxSize, message: errorUtil.toString(message) }
    });
  }
  size(size, message) {
    return this.min(size, message).max(size, message);
  }
  nonempty(message) {
    return this.min(1, message);
  }
};
ZodSet.create = (valueType, params) => {
  return new ZodSet({
    valueType,
    minSize: null,
    maxSize: null,
    typeName: ZodFirstPartyTypeKind.ZodSet,
    ...processCreateParams(params)
  });
};
var ZodFunction = class _ZodFunction extends ZodType {
  constructor() {
    super(...arguments);
    this.validate = this.implement;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.function) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.function,
        received: ctx.parsedType
      });
      return INVALID;
    }
    function makeArgsIssue(args, error) {
      return makeIssue({
        data: args,
        path: ctx.path,
        errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap(), en_default].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_arguments,
          argumentsError: error
        }
      });
    }
    function makeReturnsIssue(returns, error) {
      return makeIssue({
        data: returns,
        path: ctx.path,
        errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap(), en_default].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_return_type,
          returnTypeError: error
        }
      });
    }
    const params = { errorMap: ctx.common.contextualErrorMap };
    const fn = ctx.data;
    if (this._def.returns instanceof ZodPromise) {
      const me = this;
      return OK(async function(...args) {
        const error = new ZodError([]);
        const parsedArgs = await me._def.args.parseAsync(args, params).catch((e) => {
          error.addIssue(makeArgsIssue(args, e));
          throw error;
        });
        const result = await Reflect.apply(fn, this, parsedArgs);
        const parsedReturns = await me._def.returns._def.type.parseAsync(result, params).catch((e) => {
          error.addIssue(makeReturnsIssue(result, e));
          throw error;
        });
        return parsedReturns;
      });
    } else {
      const me = this;
      return OK(function(...args) {
        const parsedArgs = me._def.args.safeParse(args, params);
        if (!parsedArgs.success) {
          throw new ZodError([makeArgsIssue(args, parsedArgs.error)]);
        }
        const result = Reflect.apply(fn, this, parsedArgs.data);
        const parsedReturns = me._def.returns.safeParse(result, params);
        if (!parsedReturns.success) {
          throw new ZodError([makeReturnsIssue(result, parsedReturns.error)]);
        }
        return parsedReturns.data;
      });
    }
  }
  parameters() {
    return this._def.args;
  }
  returnType() {
    return this._def.returns;
  }
  args(...items) {
    return new _ZodFunction({
      ...this._def,
      args: ZodTuple.create(items).rest(ZodUnknown.create())
    });
  }
  returns(returnType) {
    return new _ZodFunction({
      ...this._def,
      returns: returnType
    });
  }
  implement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  strictImplement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  static create(args, returns, params) {
    return new _ZodFunction({
      args: args ? args : ZodTuple.create([]).rest(ZodUnknown.create()),
      returns: returns || ZodUnknown.create(),
      typeName: ZodFirstPartyTypeKind.ZodFunction,
      ...processCreateParams(params)
    });
  }
};
var ZodLazy = class extends ZodType {
  get schema() {
    return this._def.getter();
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const lazySchema = this._def.getter();
    return lazySchema._parse({ data: ctx.data, path: ctx.path, parent: ctx });
  }
};
ZodLazy.create = (getter, params) => {
  return new ZodLazy({
    getter,
    typeName: ZodFirstPartyTypeKind.ZodLazy,
    ...processCreateParams(params)
  });
};
var ZodLiteral = class extends ZodType {
  _parse(input) {
    if (input.data !== this._def.value) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_literal,
        expected: this._def.value
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
  get value() {
    return this._def.value;
  }
};
ZodLiteral.create = (value, params) => {
  return new ZodLiteral({
    value,
    typeName: ZodFirstPartyTypeKind.ZodLiteral,
    ...processCreateParams(params)
  });
};
function createZodEnum(values, params) {
  return new ZodEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodEnum,
    ...processCreateParams(params)
  });
}
var ZodEnum = class _ZodEnum extends ZodType {
  _parse(input) {
    if (typeof input.data !== "string") {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(this._def.values);
    }
    if (!this._cache.has(input.data)) {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get options() {
    return this._def.values;
  }
  get enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Values() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  extract(values, newDef = this._def) {
    return _ZodEnum.create(values, {
      ...this._def,
      ...newDef
    });
  }
  exclude(values, newDef = this._def) {
    return _ZodEnum.create(this.options.filter((opt) => !values.includes(opt)), {
      ...this._def,
      ...newDef
    });
  }
};
ZodEnum.create = createZodEnum;
var ZodNativeEnum = class extends ZodType {
  _parse(input) {
    const nativeEnumValues = util.getValidEnumValues(this._def.values);
    const ctx = this._getOrReturnCtx(input);
    if (ctx.parsedType !== ZodParsedType.string && ctx.parsedType !== ZodParsedType.number) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(util.getValidEnumValues(this._def.values));
    }
    if (!this._cache.has(input.data)) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get enum() {
    return this._def.values;
  }
};
ZodNativeEnum.create = (values, params) => {
  return new ZodNativeEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodNativeEnum,
    ...processCreateParams(params)
  });
};
var ZodPromise = class extends ZodType {
  unwrap() {
    return this._def.type;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.promise && ctx.common.async === false) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.promise,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const promisified = ctx.parsedType === ZodParsedType.promise ? ctx.data : Promise.resolve(ctx.data);
    return OK(promisified.then((data) => {
      return this._def.type.parseAsync(data, {
        path: ctx.path,
        errorMap: ctx.common.contextualErrorMap
      });
    }));
  }
};
ZodPromise.create = (schema, params) => {
  return new ZodPromise({
    type: schema,
    typeName: ZodFirstPartyTypeKind.ZodPromise,
    ...processCreateParams(params)
  });
};
var ZodEffects = class extends ZodType {
  innerType() {
    return this._def.schema;
  }
  sourceType() {
    return this._def.schema._def.typeName === ZodFirstPartyTypeKind.ZodEffects ? this._def.schema.sourceType() : this._def.schema;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const effect = this._def.effect || null;
    const checkCtx = {
      addIssue: (arg) => {
        addIssueToContext(ctx, arg);
        if (arg.fatal) {
          status.abort();
        } else {
          status.dirty();
        }
      },
      get path() {
        return ctx.path;
      }
    };
    checkCtx.addIssue = checkCtx.addIssue.bind(checkCtx);
    if (effect.type === "preprocess") {
      const processed = effect.transform(ctx.data, checkCtx);
      if (ctx.common.async) {
        return Promise.resolve(processed).then(async (processed2) => {
          if (status.value === "aborted")
            return INVALID;
          const result = await this._def.schema._parseAsync({
            data: processed2,
            path: ctx.path,
            parent: ctx
          });
          if (result.status === "aborted")
            return INVALID;
          if (result.status === "dirty")
            return DIRTY(result.value);
          if (status.value === "dirty")
            return DIRTY(result.value);
          return result;
        });
      } else {
        if (status.value === "aborted")
          return INVALID;
        const result = this._def.schema._parseSync({
          data: processed,
          path: ctx.path,
          parent: ctx
        });
        if (result.status === "aborted")
          return INVALID;
        if (result.status === "dirty")
          return DIRTY(result.value);
        if (status.value === "dirty")
          return DIRTY(result.value);
        return result;
      }
    }
    if (effect.type === "refinement") {
      const executeRefinement = (acc) => {
        const result = effect.refinement(acc, checkCtx);
        if (ctx.common.async) {
          return Promise.resolve(result);
        }
        if (result instanceof Promise) {
          throw new Error("Async refinement encountered during synchronous parse operation. Use .parseAsync instead.");
        }
        return acc;
      };
      if (ctx.common.async === false) {
        const inner = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inner.status === "aborted")
          return INVALID;
        if (inner.status === "dirty")
          status.dirty();
        executeRefinement(inner.value);
        return { status: status.value, value: inner.value };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((inner) => {
          if (inner.status === "aborted")
            return INVALID;
          if (inner.status === "dirty")
            status.dirty();
          return executeRefinement(inner.value).then(() => {
            return { status: status.value, value: inner.value };
          });
        });
      }
    }
    if (effect.type === "transform") {
      if (ctx.common.async === false) {
        const base = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (!isValid(base))
          return INVALID;
        const result = effect.transform(base.value, checkCtx);
        if (result instanceof Promise) {
          throw new Error(`Asynchronous transform encountered during synchronous parse operation. Use .parseAsync instead.`);
        }
        return { status: status.value, value: result };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((base) => {
          if (!isValid(base))
            return INVALID;
          return Promise.resolve(effect.transform(base.value, checkCtx)).then((result) => ({
            status: status.value,
            value: result
          }));
        });
      }
    }
    util.assertNever(effect);
  }
};
ZodEffects.create = (schema, effect, params) => {
  return new ZodEffects({
    schema,
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    effect,
    ...processCreateParams(params)
  });
};
ZodEffects.createWithPreprocess = (preprocess, schema, params) => {
  return new ZodEffects({
    schema,
    effect: { type: "preprocess", transform: preprocess },
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    ...processCreateParams(params)
  });
};
var ZodOptional = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.undefined) {
      return OK(void 0);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodOptional.create = (type, params) => {
  return new ZodOptional({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodOptional,
    ...processCreateParams(params)
  });
};
var ZodNullable = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.null) {
      return OK(null);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodNullable.create = (type, params) => {
  return new ZodNullable({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodNullable,
    ...processCreateParams(params)
  });
};
var ZodDefault = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    let data = ctx.data;
    if (ctx.parsedType === ZodParsedType.undefined) {
      data = this._def.defaultValue();
    }
    return this._def.innerType._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  removeDefault() {
    return this._def.innerType;
  }
};
ZodDefault.create = (type, params) => {
  return new ZodDefault({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodDefault,
    defaultValue: typeof params.default === "function" ? params.default : () => params.default,
    ...processCreateParams(params)
  });
};
var ZodCatch = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const newCtx = {
      ...ctx,
      common: {
        ...ctx.common,
        issues: []
      }
    };
    const result = this._def.innerType._parse({
      data: newCtx.data,
      path: newCtx.path,
      parent: {
        ...newCtx
      }
    });
    if (isAsync(result)) {
      return result.then((result2) => {
        return {
          status: "valid",
          value: result2.status === "valid" ? result2.value : this._def.catchValue({
            get error() {
              return new ZodError(newCtx.common.issues);
            },
            input: newCtx.data
          })
        };
      });
    } else {
      return {
        status: "valid",
        value: result.status === "valid" ? result.value : this._def.catchValue({
          get error() {
            return new ZodError(newCtx.common.issues);
          },
          input: newCtx.data
        })
      };
    }
  }
  removeCatch() {
    return this._def.innerType;
  }
};
ZodCatch.create = (type, params) => {
  return new ZodCatch({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodCatch,
    catchValue: typeof params.catch === "function" ? params.catch : () => params.catch,
    ...processCreateParams(params)
  });
};
var ZodNaN = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.nan) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.nan,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
};
ZodNaN.create = (params) => {
  return new ZodNaN({
    typeName: ZodFirstPartyTypeKind.ZodNaN,
    ...processCreateParams(params)
  });
};
var BRAND = Symbol("zod_brand");
var ZodBranded = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const data = ctx.data;
    return this._def.type._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  unwrap() {
    return this._def.type;
  }
};
var ZodPipeline = class _ZodPipeline extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.common.async) {
      const handleAsync = async () => {
        const inResult = await this._def.in._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inResult.status === "aborted")
          return INVALID;
        if (inResult.status === "dirty") {
          status.dirty();
          return DIRTY(inResult.value);
        } else {
          return this._def.out._parseAsync({
            data: inResult.value,
            path: ctx.path,
            parent: ctx
          });
        }
      };
      return handleAsync();
    } else {
      const inResult = this._def.in._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
      if (inResult.status === "aborted")
        return INVALID;
      if (inResult.status === "dirty") {
        status.dirty();
        return {
          status: "dirty",
          value: inResult.value
        };
      } else {
        return this._def.out._parseSync({
          data: inResult.value,
          path: ctx.path,
          parent: ctx
        });
      }
    }
  }
  static create(a, b) {
    return new _ZodPipeline({
      in: a,
      out: b,
      typeName: ZodFirstPartyTypeKind.ZodPipeline
    });
  }
};
var ZodReadonly = class extends ZodType {
  _parse(input) {
    const result = this._def.innerType._parse(input);
    const freeze = (data) => {
      if (isValid(data)) {
        data.value = Object.freeze(data.value);
      }
      return data;
    };
    return isAsync(result) ? result.then((data) => freeze(data)) : freeze(result);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodReadonly.create = (type, params) => {
  return new ZodReadonly({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodReadonly,
    ...processCreateParams(params)
  });
};
function cleanParams(params, data) {
  const p = typeof params === "function" ? params(data) : typeof params === "string" ? { message: params } : params;
  const p2 = typeof p === "string" ? { message: p } : p;
  return p2;
}
function custom(check, _params = {}, fatal) {
  if (check)
    return ZodAny.create().superRefine((data, ctx) => {
      const r = check(data);
      if (r instanceof Promise) {
        return r.then((r2) => {
          if (!r2) {
            const params = cleanParams(_params, data);
            const _fatal = params.fatal ?? fatal ?? true;
            ctx.addIssue({ code: "custom", ...params, fatal: _fatal });
          }
        });
      }
      if (!r) {
        const params = cleanParams(_params, data);
        const _fatal = params.fatal ?? fatal ?? true;
        ctx.addIssue({ code: "custom", ...params, fatal: _fatal });
      }
      return;
    });
  return ZodAny.create();
}
var late = {
  object: ZodObject.lazycreate
};
var ZodFirstPartyTypeKind;
(function(ZodFirstPartyTypeKind2) {
  ZodFirstPartyTypeKind2["ZodString"] = "ZodString";
  ZodFirstPartyTypeKind2["ZodNumber"] = "ZodNumber";
  ZodFirstPartyTypeKind2["ZodNaN"] = "ZodNaN";
  ZodFirstPartyTypeKind2["ZodBigInt"] = "ZodBigInt";
  ZodFirstPartyTypeKind2["ZodBoolean"] = "ZodBoolean";
  ZodFirstPartyTypeKind2["ZodDate"] = "ZodDate";
  ZodFirstPartyTypeKind2["ZodSymbol"] = "ZodSymbol";
  ZodFirstPartyTypeKind2["ZodUndefined"] = "ZodUndefined";
  ZodFirstPartyTypeKind2["ZodNull"] = "ZodNull";
  ZodFirstPartyTypeKind2["ZodAny"] = "ZodAny";
  ZodFirstPartyTypeKind2["ZodUnknown"] = "ZodUnknown";
  ZodFirstPartyTypeKind2["ZodNever"] = "ZodNever";
  ZodFirstPartyTypeKind2["ZodVoid"] = "ZodVoid";
  ZodFirstPartyTypeKind2["ZodArray"] = "ZodArray";
  ZodFirstPartyTypeKind2["ZodObject"] = "ZodObject";
  ZodFirstPartyTypeKind2["ZodUnion"] = "ZodUnion";
  ZodFirstPartyTypeKind2["ZodDiscriminatedUnion"] = "ZodDiscriminatedUnion";
  ZodFirstPartyTypeKind2["ZodIntersection"] = "ZodIntersection";
  ZodFirstPartyTypeKind2["ZodTuple"] = "ZodTuple";
  ZodFirstPartyTypeKind2["ZodRecord"] = "ZodRecord";
  ZodFirstPartyTypeKind2["ZodMap"] = "ZodMap";
  ZodFirstPartyTypeKind2["ZodSet"] = "ZodSet";
  ZodFirstPartyTypeKind2["ZodFunction"] = "ZodFunction";
  ZodFirstPartyTypeKind2["ZodLazy"] = "ZodLazy";
  ZodFirstPartyTypeKind2["ZodLiteral"] = "ZodLiteral";
  ZodFirstPartyTypeKind2["ZodEnum"] = "ZodEnum";
  ZodFirstPartyTypeKind2["ZodEffects"] = "ZodEffects";
  ZodFirstPartyTypeKind2["ZodNativeEnum"] = "ZodNativeEnum";
  ZodFirstPartyTypeKind2["ZodOptional"] = "ZodOptional";
  ZodFirstPartyTypeKind2["ZodNullable"] = "ZodNullable";
  ZodFirstPartyTypeKind2["ZodDefault"] = "ZodDefault";
  ZodFirstPartyTypeKind2["ZodCatch"] = "ZodCatch";
  ZodFirstPartyTypeKind2["ZodPromise"] = "ZodPromise";
  ZodFirstPartyTypeKind2["ZodBranded"] = "ZodBranded";
  ZodFirstPartyTypeKind2["ZodPipeline"] = "ZodPipeline";
  ZodFirstPartyTypeKind2["ZodReadonly"] = "ZodReadonly";
})(ZodFirstPartyTypeKind || (ZodFirstPartyTypeKind = {}));
var instanceOfType = (cls, params = {
  message: `Input not instance of ${cls.name}`
}) => custom((data) => data instanceof cls, params);
var stringType = ZodString.create;
var numberType = ZodNumber.create;
var nanType = ZodNaN.create;
var bigIntType = ZodBigInt.create;
var booleanType = ZodBoolean.create;
var dateType = ZodDate.create;
var symbolType = ZodSymbol.create;
var undefinedType = ZodUndefined.create;
var nullType = ZodNull.create;
var anyType = ZodAny.create;
var unknownType = ZodUnknown.create;
var neverType = ZodNever.create;
var voidType = ZodVoid.create;
var arrayType = ZodArray.create;
var objectType = ZodObject.create;
var strictObjectType = ZodObject.strictCreate;
var unionType = ZodUnion.create;
var discriminatedUnionType = ZodDiscriminatedUnion.create;
var intersectionType = ZodIntersection.create;
var tupleType = ZodTuple.create;
var recordType = ZodRecord.create;
var mapType = ZodMap.create;
var setType = ZodSet.create;
var functionType = ZodFunction.create;
var lazyType = ZodLazy.create;
var literalType = ZodLiteral.create;
var enumType = ZodEnum.create;
var nativeEnumType = ZodNativeEnum.create;
var promiseType = ZodPromise.create;
var effectsType = ZodEffects.create;
var optionalType = ZodOptional.create;
var nullableType = ZodNullable.create;
var preprocessType = ZodEffects.createWithPreprocess;
var pipelineType = ZodPipeline.create;
var ostring = () => stringType().optional();
var onumber = () => numberType().optional();
var oboolean = () => booleanType().optional();
var coerce = {
  string: (arg) => ZodString.create({ ...arg, coerce: true }),
  number: (arg) => ZodNumber.create({ ...arg, coerce: true }),
  boolean: (arg) => ZodBoolean.create({
    ...arg,
    coerce: true
  }),
  bigint: (arg) => ZodBigInt.create({ ...arg, coerce: true }),
  date: (arg) => ZodDate.create({ ...arg, coerce: true })
};
var NEVER = INVALID;

// src/assets.ts
var fs = __toESM(require("node:fs"), 1);
var path = __toESM(require("node:path"), 1);
var DEFAULT_ASSET_FOLDER = "_assets";
var DEFAULT_ASSET_BIN = "_Assets";
var IMPORTABLE = /* @__PURE__ */ new Set([
  "png",
  "jpg",
  "jpeg",
  "tif",
  "tiff",
  "psd",
  "exr",
  "dpx",
  "tga",
  "bmp",
  "gif",
  "svg",
  "ai",
  "eps",
  "pdf",
  "mov",
  "mp4",
  "m4v",
  "avi",
  "mxf",
  "webm",
  "mpg",
  "mpeg",
  "wav",
  "mp3",
  "aif",
  "aiff",
  "m4a",
  "aac"
]);
var SEQUENCE_EXT = /* @__PURE__ */ new Set(["png", "jpg", "jpeg", "tif", "tiff", "exr", "dpx", "tga", "psd", "bmp"]);
var SEQ_RE = /^(.*?)(\d+)\.([A-Za-z0-9]+)$/;
var MIN_SEQUENCE_FRAMES = 3;
var MIN_DIGITS = 3;
var MAX_DIGITS = 7;
var MAX_FILES = 5e3;
var MAX_DEPTH = 6;
function ext(name) {
  return path.extname(name).slice(1).toLowerCase();
}
function scanAssets(root, opts = {}) {
  const recursive = opts.recursive !== false;
  const sequences = opts.sequences !== false;
  const out = [];
  let count = 0;
  const walk = (dir, rel, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const files = [];
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (recursive && depth < MAX_DEPTH && !e.name.startsWith("_")) walk(full, [...rel, e.name], depth + 1);
        continue;
      }
      if (!e.isFile() || !IMPORTABLE.has(ext(e.name)) || ++count > MAX_FILES) continue;
      let mtimeMs = 0;
      let arrivedMs = 0;
      try {
        const st = fs.statSync(full);
        mtimeMs = st.mtimeMs;
        arrivedMs = Math.max(st.mtimeMs, st.ctimeMs || 0, st.birthtimeMs || 0);
      } catch {
        continue;
      }
      files.push({ name: e.name, full, mtimeMs, arrivedMs });
    }
    const groups = /* @__PURE__ */ new Map();
    const singles = [];
    for (const f of files) {
      const m = sequences ? SEQ_RE.exec(f.name) : null;
      if (m && SEQUENCE_EXT.has(m[3].toLowerCase()) && m[2].length >= MIN_DIGITS && m[2].length <= MAX_DIGITS && !/[vV]$/.test(m[1])) {
        const key = `${m[1]}\0${m[2].length}\0${m[3].toLowerCase()}`;
        groups.set(key, [...groups.get(key) ?? [], f]);
      } else singles.push(f);
    }
    for (const g of groups.values()) {
      if (g.length < MIN_SEQUENCE_FRAMES) {
        singles.push(...g);
        continue;
      }
      out.push({
        path: g[0].full,
        subfolder: rel,
        sequence: true,
        frames: g.length,
        mtimeMs: Math.max(...g.map((f) => f.mtimeMs)),
        arrivedMs: Math.max(...g.map((f) => f.arrivedMs))
      });
    }
    for (const f of singles) out.push({ path: f.full, subfolder: rel, sequence: false, mtimeMs: f.mtimeMs, arrivedMs: f.arrivedMs });
  };
  walk(root, [], 0);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
function normPath(p) {
  const s = p.replace(/\\/g, "/").normalize("NFC");
  return process.platform === "win32" ? s.toLowerCase() : s;
}
function pickNewAssets(candidates, inProject, now, settleMs, sequenceSettleMs = settleMs) {
  const have = new Set(inProject.map(normPath));
  const fresh = [];
  const already = [];
  const settling = [];
  for (const c of candidates) {
    if (have.has(normPath(c.path))) already.push(c);
    else if (now - c.arrivedMs < (c.sequence ? sequenceSettleMs : settleMs)) settling.push(c);
    else fresh.push(c);
  }
  return { fresh, already, settling };
}

// src/host.ts
var BridgeError = class extends Error {
  kind;
  line;
  actual;
  expected;
  op_id;
  constructor(detail) {
    super(detail.message);
    this.name = "BridgeError";
    this.kind = detail.kind;
    this.line = detail.line;
    this.actual = detail.actual;
    this.expected = detail.expected;
    this.op_id = detail.op_id;
  }
  toJSON() {
    const out = {
      kind: this.kind,
      message: this.message
    };
    if (this.line !== void 0) out.line = this.line;
    if (this.actual !== void 0) out.actual = this.actual;
    if (this.expected !== void 0) out.expected = this.expected;
    if (this.op_id !== void 0) out.op_id = this.op_id;
    return out;
  }
};
var DEFAULT_TIMEOUT_MS = 12e4;
var SLOW_TIMEOUT_MS = 6e5;
function normalizeErrorKind(kind) {
  switch (kind) {
    case "timeout":
    case "unreachable":
    case "queued":
    case "evalscript_error":
    case "guard":
      return kind;
    default:
      return "evalscript_error";
  }
}

// src/jsx.ts
function encodeJsxArg(value) {
  const json = JSON.stringify(value === void 0 ? null : value);
  return escapeForExtendScript(json);
}
function escapeForExtendScript(jsonLiteral) {
  let out = "";
  for (let i = 0; i < jsonLiteral.length; i++) {
    const code = jsonLiteral.charCodeAt(i);
    if (code >= 32 && code <= 126) {
      out += jsonLiteral.charAt(i);
    } else {
      out += "\\u" + code.toString(16).padStart(4, "0");
    }
  }
  return out;
}
function buildJsxCall(fn, args = {}) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(fn))) {
    throw new Error(`Invalid host function name: ${String(fn)}`);
  }
  return `__chromaAe.${fn}(${encodeJsxArg(args)})`;
}
function normalizeGuardPath(projectPath, isWindows = process.platform === "win32") {
  const trimmed = projectPath.trim();
  if (trimmed === "<unsaved>") {
    return "<unsaved>";
  }
  let normalized = trimmed.replace(/\\/g, "/");
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  if (isWindows) {
    normalized = normalized.toLowerCase();
  }
  return normalized;
}
function pathsMatchForGuard(expectedPath, actualPath, isWindows = process.platform === "win32") {
  const actual = actualPath ? actualPath : "<unsaved>";
  return normalizeGuardPath(expectedPath, isWindows) === normalizeGuardPath(actual, isWindows);
}

// src/queue.ts
var QueueWaitError = class extends Error {
  kind = "queued";
  op;
  waitedMs;
  behindOp;
  constructor(op, waitedMs, behindOp) {
    super(
      `Operation "${op}" waited ${Math.round(waitedMs / 1e3)}s in the server queue behind "${behindOp}" and was dropped before being sent to After Effects. Nothing was executed; it is safe to retry once the queue drains.`
    );
    this.name = "QueueWaitError";
    this.op = op;
    this.waitedMs = waitedMs;
    this.behindOp = behindOp;
  }
};
var DEFAULT_MAX_WAIT_MS = 6e5;
var SingleWriterQueue = class {
  holder = null;
  waiting = [];
  maxWaitMs;
  constructor(opts = {}) {
    this.maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  }
  get depth() {
    return this.waiting.filter((w) => !w.done).length;
  }
  get inFlight() {
    return this.holder;
  }
  acquire(op) {
    if (this.holder === null && this.depth === 0) {
      this.holder = op;
      return Promise.resolve(this.createLease(op, 0, null));
    }
    const behind = this.holder ?? this.waiting.find((w) => !w.done)?.op ?? "unknown";
    return new Promise((resolve2, reject) => {
      const waiter = {
        op,
        enqueuedAt: Date.now(),
        behind,
        done: false,
        resolve: resolve2,
        reject,
        cleanup: () => {
        }
      };
      const timer = setTimeout(() => {
        if (waiter.done) return;
        waiter.done = true;
        waiter.cleanup();
        reject(new QueueWaitError(op, this.maxWaitMs, waiter.behind));
        this.pump();
      }, this.maxWaitMs);
      timer.unref?.();
      waiter.cleanup = () => {
        clearTimeout(timer);
      };
      this.waiting.push(waiter);
    });
  }
  async run(op, fn) {
    const lease = await this.acquire(op);
    try {
      return await fn(lease);
    } finally {
      lease.release();
    }
  }
  createLease(op, waitedMs, queuedBehind) {
    let released = false;
    return {
      op,
      waitedMs,
      queuedBehind,
      release: () => {
        if (released) return;
        released = true;
        this.holder = null;
        this.pump();
      }
    };
  }
  pump() {
    if (this.holder !== null) return;
    while (this.waiting.length > 0) {
      const next = this.waiting.shift();
      if (next.done) continue;
      next.done = true;
      next.cleanup();
      this.holder = next.op;
      const waitedMs = Date.now() - next.enqueuedAt;
      next.resolve(this.createLease(next.op, waitedMs, next.behind));
      return;
    }
  }
};

// src/receipts.ts
var FLOAT_EPSILON = 1e-4;
function compareValues(expected, actual, currentPath = "value", mismatches = []) {
  if (expected === actual) {
    return mismatches;
  }
  if (typeof expected === "number" && typeof actual === "number") {
    if (Number.isNaN(expected) && Number.isNaN(actual)) {
      return mismatches;
    }
    if (Math.abs(expected - actual) <= FLOAT_EPSILON) {
      return mismatches;
    }
    mismatches.push({
      path: currentPath,
      expected,
      actual,
      message: `Expected ${currentPath} to be ${expected}, got ${actual}`
    });
    return mismatches;
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      if (expected.length === 2 && actual.length === 3 && typeof actual[2] === "number" && Math.abs(actual[2]) <= FLOAT_EPSILON) {
        compareValues(expected[0], actual[0], `${currentPath}[0]`, mismatches);
        compareValues(expected[1], actual[1], `${currentPath}[1]`, mismatches);
        return mismatches;
      }
      mismatches.push({
        path: currentPath,
        expected,
        actual,
        message: `Expected array length ${expected.length} at ${currentPath}, got ${actual.length}`
      });
      return mismatches;
    }
    for (let i = 0; i < expected.length; i++) {
      compareValues(
        expected[i],
        actual[i],
        `${currentPath}[${i}]`,
        mismatches
      );
    }
    return mismatches;
  }
  if (expected !== null && actual !== null && typeof expected === "object" && typeof actual === "object" && !Array.isArray(expected) && !Array.isArray(actual)) {
    const expObj = expected;
    const actObj = actual;
    for (const key of Object.keys(expObj)) {
      if (expObj[key] === void 0) continue;
      const subPath = currentPath ? `${currentPath}.${key}` : key;
      if (!(key in actObj)) {
        mismatches.push({
          path: subPath,
          expected: expObj[key],
          actual: void 0,
          message: `Missing field at ${subPath}`
        });
      } else {
        compareValues(expObj[key], actObj[key], subPath, mismatches);
      }
    }
    return mismatches;
  }
  mismatches.push({
    path: currentPath,
    expected,
    actual,
    message: `Expected ${currentPath} to match ${JSON.stringify(
      expected
    )}, got ${JSON.stringify(actual)}`
  });
  return mismatches;
}
function buildReceipt(params) {
  const mismatches = params.customMismatches ? [...params.customMismatches] : [];
  if (params.expected !== void 0) {
    const target = params.actualForExpected !== void 0 ? params.actualForExpected : params.after;
    compareValues(params.expected, target, "expected", mismatches);
  } else if (params.after === null || params.after === void 0) {
    mismatches.push({
      path: "after",
      expected: "non-null read-back snapshot",
      actual: params.after,
      message: "Read-back snapshot after mutation returned null or undefined"
    });
  }
  return {
    before: params.before,
    after: params.after,
    matches: mismatches.length === 0,
    mismatches
  };
}
var MAX_LIST_ENTRIES = 500;
var MAX_STRING_CHARS = 2e4;
function boundOutput(value) {
  return boundRecursive(value);
}
function boundRecursive(value) {
  if (typeof value === "string") {
    if (value.length > MAX_STRING_CHARS) {
      return value.slice(0, MAX_STRING_CHARS) + `... [truncated ${value.length - MAX_STRING_CHARS} chars]`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_LIST_ENTRIES) {
      return value.slice(0, MAX_LIST_ENTRIES).map((item) => boundRecursive(item));
    }
    return value.map((item) => boundRecursive(item));
  }
  if (value !== null && typeof value === "object") {
    const obj = value;
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (Array.isArray(v) && v.length > MAX_LIST_ENTRIES) {
        out[k] = v.slice(0, MAX_LIST_ENTRIES).map((item) => boundRecursive(item));
        out.truncated = true;
        out[`${k}_total`] = v.length;
      } else {
        out[k] = boundRecursive(v);
      }
    }
    return out;
  }
  return value;
}

// src/tools/common.ts
var path3 = __toESM(require("node:path"), 1);

// src/quarantine.ts
var fs2 = __toESM(require("node:fs"), 1);
var os = __toESM(require("node:os"), 1);
var path2 = __toESM(require("node:path"), 1);
var QuarantineBlockedError = class extends Error {
  kind = "quarantined";
  entries;
  constructor(entries) {
    const ids = entries.map((e) => e.op_id).join(", ");
    super(
      `Mutating tool refused: operation(s) [${ids}] are in quarantine because a previous mutation timed out with an unknown outcome. To clear quarantine: 1) call ae_status to check the panel's /health, 2) inspect the project/comp state with read tools (ae_get_project, ae_get_comp, ae_get_layer_props), and 3) call ae_acknowledge with { op_id, note } for each quarantined op.`
    );
    this.name = "QuarantineBlockedError";
    this.entries = entries;
  }
};
function defaultDataDir() {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path2.join(os.homedir(), "AppData", "Local");
    return path2.join(localAppData, "chroma-ae-mcp");
  }
  if (process.platform === "darwin") {
    return path2.join(
      os.homedir(),
      "Library",
      "Application Support",
      "chroma-ae-mcp"
    );
  }
  return path2.join(os.homedir(), ".local", "share", "chroma-ae-mcp");
}
function defaultQuarantineFilePath() {
  return path2.join(defaultDataDir(), "quarantine.json");
}
var QuarantineStore = class {
  filePath;
  entries = /* @__PURE__ */ new Map();
  constructor(filePath = defaultQuarantineFilePath()) {
    this.filePath = filePath;
    this.loadFromDisk();
  }
  get path() {
    return this.filePath;
  }
  get isQuarantined() {
    return this.entries.size > 0;
  }
  list() {
    return Array.from(this.entries.values());
  }
  get(opId) {
    return this.entries.get(opId);
  }
  /**
   * Throws QuarantineBlockedError if any operation is currently in quarantine.
   */
  assertClear() {
    if (this.entries.size > 0) {
      throw new QuarantineBlockedError(this.list());
    }
  }
  /**
   * Adds a timed-out mutating operation to quarantine and persists to disk.
   */
  add(entry) {
    const record = {
      op_id: entry.op_id,
      tool: entry.tool,
      label: entry.label,
      quarantined_at: entry.quarantined_at ?? (/* @__PURE__ */ new Date()).toISOString(),
      reason: entry.reason ?? "Mutating operation timed out; outcome in After Effects is unknown."
    };
    this.entries.set(record.op_id, record);
    this.saveToDisk();
    return record;
  }
  /**
   * Removes an operation from quarantine by op_id and updates the JSON mirror.
   */
  acknowledge(opId, note) {
    const existing = this.entries.get(opId);
    if (!existing) {
      return {
        acknowledged: false,
        op_id: opId,
        note,
        remaining: this.list()
      };
    }
    this.entries.delete(opId);
    this.saveToDisk();
    return {
      acknowledged: true,
      op_id: opId,
      note,
      removed: existing,
      remaining: this.list()
    };
  }
  loadFromDisk() {
    try {
      if (!fs2.existsSync(this.filePath)) {
        return;
      }
      const raw = fs2.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && Array.isArray(parsed.entries) ? parsed.entries : [];
      for (const item of list) {
        if (item && typeof item === "object" && typeof item.op_id === "string") {
          const e = item;
          this.entries.set(e.op_id, {
            op_id: e.op_id,
            tool: typeof e.tool === "string" ? e.tool : "unknown",
            label: typeof e.label === "string" ? e.label : "",
            quarantined_at: typeof e.quarantined_at === "string" ? e.quarantined_at : (/* @__PURE__ */ new Date()).toISOString(),
            reason: typeof e.reason === "string" ? e.reason : ""
          });
        }
      }
    } catch {
    }
  }
  saveToDisk() {
    const dir = path2.dirname(this.filePath);
    fs2.mkdirSync(dir, { recursive: true, mode: 448 });
    const payload = JSON.stringify({ entries: this.list() }, null, 2);
    const tmpFile = `${this.filePath}.tmp-${process.pid}`;
    fs2.writeFileSync(tmpFile, payload, { encoding: "utf8", mode: 384 });
    fs2.renameSync(tmpFile, this.filePath);
  }
};

// src/tools/common.ts
var AGENT_SAFETY_GUIDANCE = "IMPORTANT: (1) Always re-read project/comp state before writing. (2) Long synchronous loops in ExtendScript freeze After Effects' UI. (3) Jay may be editing live in After Effects, so a target guard failure (kind: 'guard') means STOP and re-read state\u2014do NOT retry with stale expectations.";
var ExpectSchema = external_exports.object({
  project_path: external_exports.string().min(1).describe(
    "Expected absolute path to the open .aep project file, or '<unsaved>' if the project has not been saved yet."
  ),
  comp_id: external_exports.number().int().optional().describe(
    "Optional expected CompItem ID. If provided, app.project.itemByID(comp_id) must be a CompItem."
  )
}).describe(
  "Target guard verified before any mutation runs. Refuses with kind:'guard' on mismatch."
);
var LayerSelectorSchema = external_exports.object({
  index: external_exports.number().int().positive().optional().describe("1-based layer index in the composition."),
  name: external_exports.string().min(1).optional().describe("Layer name."),
  id: external_exports.number().int().optional().describe("Unique layer ID.")
}).refine(
  (val) => val.index !== void 0 || val.name !== void 0 || val.id !== void 0,
  {
    message: "Layer selector must specify at least one of: index, name, or id."
  }
).describe("Identifies a layer within a composition by id, index, or name.");
function dataDirOf(ctx) {
  if (ctx.dataDir) return ctx.dataDir;
  if (ctx.settings) return path3.dirname(ctx.settings.path);
  return defaultDataDir();
}
function formatToolResponse(data) {
  const bounded = boundOutput(data);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(bounded, null, 2)
      }
    ]
  };
}
function formatToolError(err) {
  if (err instanceof BridgeError) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify(err.toJSON(), null, 2)
        }
      ]
    };
  }
  if (err instanceof QuarantineBlockedError) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              kind: err.kind,
              message: err.message,
              quarantine: err.entries
            },
            null,
            2
          )
        }
      ]
    };
  }
  if (err instanceof QueueWaitError) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              kind: err.kind,
              message: err.message,
              op: err.op,
              waitedMs: err.waitedMs,
              behindOp: err.behindOp
            },
            null,
            2
          )
        }
      ]
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            kind: "error",
            message
          },
          null,
          2
        )
      }
    ]
  };
}

// src/tools/mutate.ts
var fs5 = __toESM(require("node:fs"), 1);
var path6 = __toESM(require("node:path"), 1);

// src/settings.ts
var fs3 = __toESM(require("node:fs"), 1);
var path4 = __toESM(require("node:path"), 1);
var DEFAULT_SETTINGS = {
  auto_checkpoint: { enabled: true, max_mb: 250 },
  taste: { preferred_ease: null, allow_linear_non_motion: false, avoid_overshoot: false, notes: "" },
  asset_watch: { enabled: false, since: null, recursive: true, sequences: true }
};
function defaultSettingsFilePath() {
  return path4.join(defaultDataDir(), "settings.json");
}
function cloneTaste(t) {
  return { ...t, preferred_ease: t.preferred_ease ? [...t.preferred_ease] : null };
}
function cloneDefaults() {
  return {
    auto_checkpoint: { ...DEFAULT_SETTINGS.auto_checkpoint },
    taste: cloneTaste(DEFAULT_SETTINGS.taste),
    asset_watch: { ...DEFAULT_SETTINGS.asset_watch }
  };
}
var MIN_HANDLE = 1e-3;
function isCurve(v) {
  return Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === "number" && Number.isFinite(n)) && v[0] >= MIN_HANDLE && v[0] <= 1 && v[2] >= 0 && v[2] <= 1 - MIN_HANDLE;
}
var SettingsStore = class {
  filePath;
  settings = cloneDefaults();
  constructor(filePath = defaultSettingsFilePath()) {
    this.filePath = filePath;
    this.loadFromDisk();
  }
  get path() {
    return this.filePath;
  }
  get() {
    return {
      auto_checkpoint: { ...this.settings.auto_checkpoint },
      taste: cloneTaste(this.settings.taste),
      asset_watch: { ...this.settings.asset_watch }
    };
  }
  updateAssetWatch(patch) {
    const next = { ...this.settings.asset_watch };
    if (patch.enabled !== void 0) next.enabled = patch.enabled;
    if (patch.since !== void 0) next.since = patch.since;
    if (patch.recursive !== void 0) next.recursive = patch.recursive;
    if (patch.sequences !== void 0) next.sequences = patch.sequences;
    this.settings = { ...this.settings, asset_watch: next };
    this.saveToDisk();
    return this.get();
  }
  updateTaste(patch) {
    const next = cloneTaste(this.settings.taste);
    if (patch.preferred_ease !== void 0) next.preferred_ease = isCurve(patch.preferred_ease) ? [...patch.preferred_ease] : null;
    if (patch.allow_linear_non_motion !== void 0) next.allow_linear_non_motion = patch.allow_linear_non_motion;
    if (patch.avoid_overshoot !== void 0) next.avoid_overshoot = patch.avoid_overshoot;
    if (patch.notes !== void 0) next.notes = patch.notes;
    this.settings = { ...this.settings, taste: next };
    this.saveToDisk();
    return this.get();
  }
  updateAutoCheckpoint(patch) {
    const next = { ...this.settings.auto_checkpoint };
    if (patch.enabled !== void 0) next.enabled = patch.enabled;
    if (patch.max_mb !== void 0) next.max_mb = patch.max_mb;
    this.settings = { ...this.settings, auto_checkpoint: next };
    this.saveToDisk();
    return this.get();
  }
  loadFromDisk() {
    try {
      if (!fs3.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs3.readFileSync(this.filePath, "utf8"));
      const ac = parsed?.auto_checkpoint;
      if (ac && typeof ac === "object") {
        if (typeof ac.enabled === "boolean") this.settings.auto_checkpoint.enabled = ac.enabled;
        if (typeof ac.max_mb === "number" && ac.max_mb > 0) this.settings.auto_checkpoint.max_mb = ac.max_mb;
      }
      const t = parsed?.taste;
      if (t && typeof t === "object") {
        if (isCurve(t.preferred_ease)) this.settings.taste.preferred_ease = [...t.preferred_ease];
        if (typeof t.allow_linear_non_motion === "boolean") this.settings.taste.allow_linear_non_motion = t.allow_linear_non_motion;
        if (typeof t.avoid_overshoot === "boolean") this.settings.taste.avoid_overshoot = t.avoid_overshoot;
        if (typeof t.notes === "string") this.settings.taste.notes = t.notes;
      }
      const aw = parsed?.asset_watch;
      if (aw && typeof aw === "object") {
        if (typeof aw.enabled === "boolean") this.settings.asset_watch.enabled = aw.enabled;
        if (typeof aw.since === "string" && !Number.isNaN(Date.parse(aw.since))) this.settings.asset_watch.since = aw.since;
        if (typeof aw.recursive === "boolean") this.settings.asset_watch.recursive = aw.recursive;
        if (typeof aw.sequences === "boolean") this.settings.asset_watch.sequences = aw.sequences;
      }
    } catch {
    }
  }
  saveToDisk() {
    fs3.mkdirSync(path4.dirname(this.filePath), { recursive: true, mode: 448 });
    const tmpFile = `${this.filePath}.tmp-${process.pid}`;
    fs3.writeFileSync(tmpFile, JSON.stringify(this.settings, null, 2), { encoding: "utf8", mode: 384 });
    fs3.renameSync(tmpFile, this.filePath);
  }
};

// src/skills.ts
var fs4 = __toESM(require("node:fs"), 1);
var path5 = __toESM(require("node:path"), 1);
var SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
var RESERVED_SKILL_NAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;
function isValidSkillName(name) {
  return SKILL_NAME_RE.test(name) && !RESERVED_SKILL_NAME_RE.test(name);
}
var PROJECT_SKILLS_DIR = "ae-skills";
var STEP_RE = /^(\d{1,3})\.jsx$/i;
var MAX_STEP_BYTES = 256 * 1024;
function oversizedSteps(steps) {
  const out = [];
  steps.forEach((code, i) => {
    const bytes = Buffer.byteLength(code, "utf8");
    if (bytes > MAX_STEP_BYTES) {
      out.push(`${i + 1}.jsx is ${Math.ceil(bytes / 1024)} KB; a step can be at most ${MAX_STEP_BYTES / 1024} KB (UTF-8)`);
    }
  });
  return out;
}
function projectSkillsRoot(projectPath) {
  return path5.join(path5.dirname(projectPath), PROJECT_SKILLS_DIR);
}
function globalSkillsRoot(dataDir) {
  return path5.join(dataDir, "skills");
}
function parseSkillMd(text) {
  const meta = {};
  const normalized = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);
  if (!m) return { meta, body: normalized.trim() };
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: normalized.slice(m[0].length).trim() };
}
function oneLine(s) {
  return s.replace(/\s+/g, " ").trim();
}
function escapeLineSeparators(json) {
  const bs = String.fromCharCode(92);
  return json.split(String.fromCharCode(8232)).join(bs + "u2028").split(String.fromCharCode(8233)).join(bs + "u2029");
}
function formatSkillMd(meta, instructions) {
  const lines = ["---", `name: ${meta.name}`, `description: ${oneLine(meta.description)}`, `mutates: ${meta.mutates}`];
  if (meta.args_example) lines.push(`args: ${escapeLineSeparators(meta.args_example)}`);
  lines.push("---", "", instructions.trim(), "");
  return lines.join("\n");
}
function readSkillDir(dir, scope) {
  if (!fs4.existsSync(path5.join(dir, "SKILL.md"))) return null;
  try {
    return readSkillFiles(dir, scope);
  } catch (err) {
    return {
      name: path5.basename(dir),
      description: "",
      mutates: true,
      scope,
      dir,
      instructions: "",
      steps: [],
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
function readSkillFiles(dir, scope) {
  const { meta, body } = parseSkillMd(fs4.readFileSync(path5.join(dir, "SKILL.md"), "utf8"));
  const name = path5.basename(dir);
  const steps = fs4.readdirSync(dir).map((f) => ({ f, m: STEP_RE.exec(f) })).filter((x) => x.m !== null).sort((a, b) => Number(a.m[1]) - Number(b.m[1])).map(({ f }) => {
    const full = path5.join(dir, f);
    const size = fs4.statSync(full).size;
    if (size > MAX_STEP_BYTES) throw new Error(`${full} is over ${MAX_STEP_BYTES / 1024} KB`);
    return { file: f, code: fs4.readFileSync(full, "utf8").replace(/^﻿/, "") };
  });
  return {
    name,
    display_name: meta.name && meta.name !== name ? meta.name : void 0,
    description: meta.description ?? "",
    mutates: meta.mutates !== "false",
    args_example: meta.args || void 0,
    scope,
    dir,
    instructions: body,
    steps
  };
}
function listSkills(roots2) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const { scope, root } of roots2) {
    let entries;
    try {
      entries = fs4.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries.filter((d) => d.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const skill = readSkillDir(path5.join(root, e.name), scope);
      if (!skill || seen.has(e.name)) continue;
      seen.add(e.name);
      out.push(skill);
    }
  }
  return out;
}
function findSkill(roots2, name) {
  for (const { scope, root } of roots2) {
    const dir = path5.join(root, name);
    const skill = fs4.existsSync(dir) ? readSkillDir(dir, scope) : null;
    if (skill) return skill;
  }
  return null;
}
function writeSkill(root, meta, instructions, steps, overwrite) {
  if (!isValidSkillName(meta.name)) {
    throw new Error(`Bad skill name "${meta.name}": use lowercase letters, digits and dashes (not a Windows device name like con or nul).`);
  }
  const dir = path5.join(root, meta.name);
  const exists = fs4.existsSync(path5.join(dir, "SKILL.md"));
  if (exists && !overwrite) {
    throw new Error(`A skill named "${meta.name}" already exists in ${root}. Pass overwrite: true to replace it.`);
  }
  fs4.mkdirSync(dir, { recursive: true });
  for (const f of fs4.readdirSync(dir)) if (STEP_RE.test(f)) fs4.unlinkSync(path5.join(dir, f));
  const files = [];
  steps.forEach((code, i) => {
    const file = `${i + 1}.jsx`;
    fs4.writeFileSync(path5.join(dir, file), code.endsWith("\n") ? code : `${code}
`, "utf8");
    files.push(file);
  });
  fs4.writeFileSync(path5.join(dir, "SKILL.md"), formatSkillMd(meta, instructions), "utf8");
  files.unshift("SKILL.md");
  return { dir, replaced: exists, files };
}
var MAX_RECORDED = 50;
var recorded = [];
function recordRunJsx(entry) {
  recorded.push(entry);
  if (recorded.length > MAX_RECORDED) recorded.splice(0, recorded.length - MAX_RECORDED);
}
function recordedRunJsx(opId) {
  return recorded.find((r) => r.op_id === opId);
}
function recentRunJsx() {
  return recorded.slice().reverse();
}

// src/tools/mutate.ts
var KeyframeItemSchema = external_exports.object({
  time: external_exports.number().describe("Keyframe time in seconds."),
  value: external_exports.unknown().describe("Keyframe value at `time`."),
  interp: external_exports.enum(["linear", "bezier", "hold"]).optional().describe("Optional interpolation mode ('linear', 'bezier', or 'hold').")
});
var AeRunJsxSchema = external_exports.object({
  code: external_exports.string().min(1).describe(
    "Body of an ExtendScript function to run; use `return <value>` to return a result. Errors map back to the line in `code`."
  ),
  mutates: external_exports.boolean().describe(
    "True if the script mutates After Effects state (wraps in an undo group, requires `expect`, and records a before/after receipt)."
  ),
  label: external_exports.string().min(1).describe("Human-readable label for the undo group and panel log."),
  expect: ExpectSchema.optional().describe(
    "Required when `mutates` is true. Verifies project_path and optional comp_id before running."
  )
}).superRefine((val, ctx) => {
  if (val.mutates && !val.expect) {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      path: ["expect"],
      message: "`expect` is required when `mutates` is true."
    });
  }
});
var AeSetPropertySchema = external_exports.object({
  comp_id: external_exports.number().int().describe("Target CompItem ID."),
  layer: LayerSelectorSchema,
  path: external_exports.array(external_exports.string().min(1)).min(1).describe(
    "Property path from the layer root (e.g. ['Transform', 'Opacity'] or ['ADBE Transform Group', 'ADBE Opacity'])."
  ),
  value: external_exports.unknown().optional().describe("Static value to set on the property (when not keyframed)."),
  keyframes: external_exports.array(KeyframeItemSchema).optional().describe("Keyframes to set on the property."),
  expression: external_exports.string().optional().describe("Expression string to assign to the property."),
  expect: ExpectSchema
}).refine(
  (val) => val.value !== void 0 || val.keyframes !== void 0 && val.keyframes.length > 0 || val.expression !== void 0,
  {
    message: "ae_set_property requires at least one of `value`, `keyframes`, or `expression`."
  }
);
var AeSaveSchema = external_exports.object({
  expect: ExpectSchema,
  backup: external_exports.boolean().default(true).optional().describe(
    "If true (default), the server copies the existing .aep file to <project dir>/_mcp_backups/<name>_<yyyyMMdd-HHmmss>.aep before calling app.project.save()."
  )
});
async function verifyTargetGuard(ctx, expect, opId) {
  const resp = await ctx.bridge.evalRaw({
    id: `${opId}_guard`,
    script: buildJsxCall("checkGuard", { expect }),
    label: "checkGuard",
    mutates: false,
    toolName: "checkGuard"
  });
  const res = resp.result ?? {};
  const actualPath = res.project_path ?? "<unsaved>";
  if (!pathsMatchForGuard(expect.project_path, actualPath)) {
    throw new BridgeError({
      kind: "guard",
      op_id: opId,
      message: `Target guard refused mutation: expected project_path "${expect.project_path}", but After Effects has "${actualPath}" open. Jay may be editing live \u2014 stop and re-read state, do not retry blindly.`,
      expected: expect,
      actual: {
        project_path: actualPath,
        comp_id: res.comp_id ?? null
      }
    });
  }
  if (expect.comp_id !== void 0 && res.comp_is_valid === false) {
    throw new BridgeError({
      kind: "guard",
      op_id: opId,
      message: `Target guard refused mutation: expected comp_id ${expect.comp_id} to be a CompItem, but it was not found or is not a CompItem. Stop and re-read state.`,
      expected: expect,
      actual: {
        project_path: actualPath,
        comp_id: res.comp_id ?? null
      }
    });
  }
  return res;
}
function formatBackupTimestamp(date = /* @__PURE__ */ new Date()) {
  const yyyy = String(date.getFullYear());
  const MM = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const HH = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${yyyy}${MM}${dd}-${HH}${mm}${ss}`;
}
var MAX_TRACKED_PROJECTS = 200;
var lastAutoCheckpoint = /* @__PURE__ */ new Map();
function rememberAutoCheckpoint(key, entry) {
  lastAutoCheckpoint.delete(key);
  lastAutoCheckpoint.set(key, entry);
  while (lastAutoCheckpoint.size > MAX_TRACKED_PROJECTS) {
    const oldestKey = lastAutoCheckpoint.keys().next().value;
    if (oldestKey === void 0) break;
    lastAutoCheckpoint.delete(oldestKey);
  }
}
function checkpointDirFor(projectPath) {
  const dir = path6.dirname(projectPath);
  return path6.basename(dir) === "_mcp_checkpoints" ? dir : path6.join(dir, "_mcp_checkpoints");
}
async function autoCheckpoint(ctx, guard, toolName) {
  const settings = ctx.settings?.get().auto_checkpoint ?? DEFAULT_SETTINGS.auto_checkpoint;
  if (!settings.enabled) {
    return { status: "skipped", reason: "Auto checkpoints are off (see ae_auto_checkpoint)." };
  }
  const projectPath = guard.project_path ?? "<unsaved>";
  if (projectPath === "<unsaved>") {
    return { status: "skipped", reason: "The project has never been saved, so there is no file to copy." };
  }
  let stat;
  try {
    stat = await fs5.promises.stat(projectPath);
  } catch {
    return { status: "skipped", reason: `The project file is not on disk: "${projectPath}".` };
  }
  const sizeMb = stat.size / (1024 * 1024);
  if (sizeMb > settings.max_mb) {
    return {
      status: "skipped",
      reason: `The project file is ${sizeMb.toFixed(0)} MB, over the ${settings.max_mb} MB limit (see ae_auto_checkpoint).`
    };
  }
  const unsaved = guard.dirty === false ? {} : { unsaved_changes_not_included: true };
  const key = normalizeGuardPath(projectPath);
  const last = lastAutoCheckpoint.get(key);
  if (last && last.size === stat.size && last.mtimeMs === stat.mtimeMs && fs5.existsSync(last.path)) {
    rememberAutoCheckpoint(key, last);
    return { status: "reused", path: last.path, ...unsaved };
  }
  const ext2 = path6.extname(projectPath) || ".aep";
  const dir = checkpointDirFor(projectPath);
  const stem = `${path6.basename(projectPath, ext2)}_${formatBackupTimestamp(/* @__PURE__ */ new Date())}_auto-${toolName}`;
  try {
    await fs5.promises.mkdir(dir, { recursive: true });
    let target = path6.join(dir, `${stem}${ext2}`);
    for (let n = 2; fs5.existsSync(target); n++) target = path6.join(dir, `${stem}-${n}${ext2}`);
    await fs5.promises.copyFile(projectPath, target, fs5.constants.COPYFILE_EXCL);
    rememberAutoCheckpoint(key, { size: stat.size, mtimeMs: stat.mtimeMs, path: target });
    return { status: "created", path: target, ...unsaved };
  } catch (err) {
    return {
      status: "skipped",
      reason: `Copying the project failed: ${err instanceof Error ? err.message : String(err)}`
    };
  }
}
var mutateTools = [
  {
    name: "ae_run_jsx",
    description: "Execute ExtendScript code (the body of a function; use `return` to return a value). When `mutates: true`, `expect` is required, the script runs inside a single undo group (`label`), and a separate read-back evalScript produces a before/after receipt of `expect.comp_id` (or project summary). Note: `app.executeCommand` silently does nothing through CEP; use DOM methods instead (e.g. `layer.duplicate()`). Never use chained ternaries (`a ? b : c ? d : e`) in ExtendScript as it parses them left-associatively; use `if/else`. The result's `op_id` can be passed to ae_skill_save to keep a script that worked as a reusable skill. " + AGENT_SAFETY_GUIDANCE,
    schema: AeRunJsxSchema,
    handler: async (args, ctx) => {
      if (!args.mutates) {
        const res = await ctx.bridge.callHost(
          "runUserJsx",
          {
            code: args.code,
            mutates: false,
            label: args.label
          },
          {
            label: `ae_run_jsx: ${args.label}`,
            mutates: false,
            toolName: "ae_run_jsx"
          }
        );
        recordRunJsx({ op_id: res.id, label: args.label, code: args.code, mutates: false, at: (/* @__PURE__ */ new Date()).toISOString() });
        return { op_id: res.id, result: res.result };
      }
      ctx.quarantine.assertClear();
      const expect = args.expect;
      const opId = ctx.bridge.newOpId();
      try {
        return await ctx.queue.run(`ae_run_jsx: ${args.label}`, async () => {
          ctx.quarantine.assertClear();
          const guard = await verifyTargetGuard(ctx, expect, opId);
          const checkpoint = await autoCheckpoint(ctx, guard, "ae_run_jsx");
          const beforeSnap = await ctx.bridge.evalRaw({
            id: `${opId}_before`,
            script: buildJsxCall("snapshotForReceipt", {
              comp_id: expect.comp_id
            }),
            label: `${args.label} (before snapshot)`,
            mutates: false,
            toolName: "ae_run_jsx"
          });
          const writeResp = await ctx.bridge.evalRaw({
            id: opId,
            script: buildJsxCall("runUserJsx", {
              code: args.code,
              mutates: true,
              label: args.label,
              expect
            }),
            label: args.label,
            mutates: true,
            toolName: "ae_run_jsx"
          });
          const afterSnap = await ctx.bridge.evalRaw({
            id: `${opId}_after`,
            script: buildJsxCall("snapshotForReceipt", {
              comp_id: expect.comp_id
            }),
            label: `${args.label} (after snapshot)`,
            mutates: false,
            toolName: "ae_run_jsx"
          });
          const receipt = buildReceipt({
            before: beforeSnap.result,
            after: afterSnap.result
          });
          recordRunJsx({ op_id: opId, label: args.label, code: args.code, mutates: true, at: (/* @__PURE__ */ new Date()).toISOString() });
          return {
            op_id: opId,
            applied: true,
            result: writeResp.result,
            checkpoint,
            receipt
          };
        });
      } catch (err) {
        if (err instanceof QueueWaitError) {
          throw new BridgeError({
            kind: "queued",
            op_id: opId,
            message: err.message
          });
        }
        throw err;
      }
    }
  },
  {
    name: "ae_set_property",
    description: "Mutate a layer property's value, keyframes, or expression within one undo group, guarded by `expect`, and verified by a separate read-back evalScript receipt. " + AGENT_SAFETY_GUIDANCE,
    schema: AeSetPropertySchema,
    handler: async (args, ctx) => {
      ctx.quarantine.assertClear();
      const opId = ctx.bridge.newOpId();
      const label = `ae_set_property(${args.path.join(".")})`;
      const effectiveExpect = {
        project_path: args.expect.project_path,
        comp_id: args.expect.comp_id ?? args.comp_id
      };
      try {
        return await ctx.queue.run(label, async () => {
          ctx.quarantine.assertClear();
          const guard = await verifyTargetGuard(ctx, effectiveExpect, opId);
          const checkpoint = await autoCheckpoint(ctx, guard, "ae_set_property");
          const beforeSnap = await ctx.bridge.evalRaw({
            id: `${opId}_before`,
            script: buildJsxCall("getLayerProps", {
              comp_id: args.comp_id,
              layer: args.layer,
              path: args.path,
              depth: 1
            }),
            label: `${label} (before)`,
            mutates: false,
            toolName: "ae_set_property"
          });
          const writeResp = await ctx.bridge.evalRaw({
            id: opId,
            script: buildJsxCall("setProperty", {
              comp_id: args.comp_id,
              layer: args.layer,
              path: args.path,
              value: args.value,
              keyframes: args.keyframes,
              expression: args.expression,
              expect: effectiveExpect
            }),
            label,
            mutates: true,
            toolName: "ae_set_property"
          });
          const afterSnap = await ctx.bridge.evalRaw({
            id: `${opId}_after`,
            script: buildJsxCall("getLayerProps", {
              comp_id: args.comp_id,
              layer: args.layer,
              path: args.path,
              depth: 1
            }),
            label: `${label} (after)`,
            mutates: false,
            toolName: "ae_set_property"
          });
          const expectedCheck = {};
          const actualCheck = {};
          const afterObj = afterSnap.result ?? {};
          const propObj = afterObj.property && typeof afterObj.property === "object" ? afterObj.property : afterObj;
          if (args.value !== void 0) {
            expectedCheck.value = args.value;
            actualCheck.value = propObj.value;
          }
          if (args.expression !== void 0) {
            expectedCheck.expression = args.expression;
            actualCheck.expression = propObj.expression;
          }
          if (args.keyframes !== void 0) {
            expectedCheck.numKeys = args.keyframes.length;
            actualCheck.numKeys = typeof propObj.numKeys === "number" ? propObj.numKeys : Array.isArray(propObj.keyframes) ? propObj.keyframes.length : void 0;
          }
          const receipt = buildReceipt({
            before: beforeSnap.result,
            after: afterSnap.result,
            expected: Object.keys(expectedCheck).length > 0 ? expectedCheck : void 0,
            actualForExpected: Object.keys(expectedCheck).length > 0 ? actualCheck : void 0
          });
          return {
            op_id: opId,
            applied: true,
            result: writeResp.result,
            checkpoint,
            receipt
          };
        });
      } catch (err) {
        if (err instanceof QueueWaitError) {
          throw new BridgeError({
            kind: "queued",
            op_id: opId,
            message: err.message
          });
        }
        throw err;
      }
    }
  },
  {
    name: "ae_save",
    description: "Save the current After Effects project (`app.project.save()`). If `backup` is true (default), the server first copies the existing .aep on disk using Node fs to `<project dir>/_mcp_backups/<name>_<yyyyMMdd-HHmmss>.aep`, and returns both paths and sizes. Never uses save-as for backups so the open project is not retargeted. " + AGENT_SAFETY_GUIDANCE,
    schema: AeSaveSchema,
    handler: async (args, ctx) => {
      ctx.quarantine.assertClear();
      const opId = ctx.bridge.newOpId();
      const doBackup = args.backup ?? true;
      try {
        return await ctx.queue.run("ae_save", async () => {
          ctx.quarantine.assertClear();
          const guardInfo = await verifyTargetGuard(ctx, args.expect, opId);
          const actualProjectPath = guardInfo.project_path ?? args.expect.project_path;
          if (actualProjectPath === "<unsaved>") {
            throw new BridgeError({
              kind: "guard",
              op_id: opId,
              message: "Cannot run ae_save on an unsaved project (<unsaved>). Save the project once in After Effects first.",
              expected: args.expect,
              actual: { project_path: "<unsaved>" }
            });
          }
          let backupPath = null;
          let backupSize = null;
          let beforeSize = null;
          if (fs5.existsSync(actualProjectPath)) {
            beforeSize = fs5.statSync(actualProjectPath).size;
            if (doBackup) {
              const projDir = path6.dirname(actualProjectPath);
              const ext2 = path6.extname(actualProjectPath) || ".aep";
              const baseName = path6.basename(actualProjectPath, ext2);
              const backupDir = path6.join(projDir, "_mcp_backups");
              fs5.mkdirSync(backupDir, { recursive: true });
              const stamp = formatBackupTimestamp(/* @__PURE__ */ new Date());
              backupPath = path6.join(backupDir, `${baseName}_${stamp}${ext2}`);
              fs5.copyFileSync(actualProjectPath, backupPath);
              backupSize = fs5.statSync(backupPath).size;
            }
          }
          const saveResp = await ctx.bridge.evalRaw({
            id: opId,
            script: buildJsxCall("save", {
              expect: args.expect
            }),
            label: "ae_save",
            timeoutMs: SLOW_TIMEOUT_MS,
            mutates: true,
            toolName: "ae_save"
          });
          const afterStatus = await ctx.bridge.evalRaw({
            id: `${opId}_after`,
            script: buildJsxCall("status", {}),
            label: "ae_save (after status)",
            mutates: false,
            toolName: "ae_save"
          });
          const savedSize = fs5.existsSync(actualProjectPath) ? fs5.statSync(actualProjectPath).size : null;
          const receipt = buildReceipt({
            before: {
              project_path: actualProjectPath,
              size: beforeSize
            },
            after: {
              project_path: actualProjectPath,
              size: savedSize,
              dirty: afterStatus.result?.dirty ?? false
            },
            expected: { dirty: false },
            actualForExpected: {
              dirty: afterStatus.result?.dirty ?? false
            }
          });
          return {
            op_id: opId,
            applied: true,
            project_path: actualProjectPath,
            project_size: savedSize,
            backup_path: backupPath,
            backup_size: backupSize,
            result: saveResp.result,
            receipt
          };
        });
      } catch (err) {
        if (err instanceof QueueWaitError) {
          throw new BridgeError({
            kind: "queued",
            op_id: opId,
            message: err.message
          });
        }
        throw err;
      }
    }
  }
];

// src/tools/ext/assets.ts
var SETTLE_MS = 2e3;
var SEQUENCE_SETTLE_MS = 1e4;
var BACKOFF_BASE_MS = 5e3;
var BACKOFF_MAX_MS = 6e4;
var MAX_IMPORT = 200;
var AeImportAssetsSchema = external_exports.object({
  folder: external_exports.string().min(1).optional().describe(`Absolute folder to import from. Default: ${DEFAULT_ASSET_FOLDER}/ next to the open .aep (created if missing).`),
  bin: external_exports.string().min(1).max(200).optional().describe(`Project folder to import into; subfolders mirror the asset folder's. Default '${DEFAULT_ASSET_BIN}'.`),
  recursive: external_exports.boolean().optional().describe("Include subfolders (except ones starting with _ or .). Default true."),
  sequences: external_exports.boolean().optional().describe("Import numbered stills (shot_0001.png ...) as one sequence. Default true."),
  dry_run: external_exports.boolean().optional().describe("List what would be imported without importing."),
  watch: external_exports.boolean().optional().describe(`Turn auto-import on or off: while on, files that arrive in ${DEFAULT_ASSET_FOLDER}/ next to whichever project is open are imported into ${DEFAULT_ASSET_BIN} within seconds. Persists across restarts.`),
  expect: external_exports.object({ project_path: external_exports.string().min(1) }).describe("The open project's path; the import is refused if another project is open.")
});
async function readFootagePaths(ctx, label, toolName) {
  const res = await ctx.bridge.evalRaw({
    id: `${ctx.bridge.newOpId()}_footage`,
    script: buildJsxCall("footagePaths", {}),
    label,
    mutates: false,
    toolName
  });
  return res.result;
}
function plan(c) {
  return { path: c.path.replace(/\\/g, "/"), subfolder: c.subfolder, sequence: c.sequence };
}
async function importAssetFiles(ctx, projectPath, bin, fresh, toolName) {
  ctx.quarantine.assertClear();
  const opId = ctx.bridge.newOpId();
  const expect = { project_path: projectPath };
  const noop = { op_id: opId, imported: [], failed: [], checkpoint: null, receipt: null };
  const readBin = (suffix) => ctx.bridge.evalRaw({
    id: `${opId}_${suffix}`,
    script: buildJsxCall("assetBinContents", { bin }),
    label: `${toolName} (${suffix} bin)`,
    mutates: false,
    toolName
  });
  try {
    return await ctx.queue.run(`${toolName}: import ${fresh.length}`, async () => {
      ctx.quarantine.assertClear();
      const guard = await verifyTargetGuard(ctx, expect, opId);
      const current = await readFootagePaths(ctx, `${toolName} (footage, recheck)`, toolName);
      const have = new Set((current.paths ?? []).map(normPath));
      const todo = fresh.filter((c) => !have.has(normPath(c.path)));
      if (todo.length === 0) return noop;
      const checkpoint = await autoCheckpoint(ctx, guard, toolName);
      const before = await readBin("before");
      const write = await ctx.bridge.evalRaw({
        id: opId,
        script: buildJsxCall("importAssets", { expect, bin, items: todo.map(plan) }),
        label: `${toolName}: import ${todo.length} file(s) into ${bin}`,
        mutates: true,
        toolName
      });
      const after = await readBin("after");
      const inBin = new Set((after.result?.items ?? []).map((i) => i.path ? normPath(i.path) : ""));
      const mismatches = write.result.imported.filter((i) => !inBin.has(normPath(i.path))).map((i) => ({ path: `bin.${i.name}`, expected: i.path, actual: void 0, message: `${i.name} is not in ${bin} after the import` }));
      return {
        op_id: opId,
        imported: write.result.imported,
        failed: write.result.failed,
        checkpoint,
        receipt: buildReceipt({ before: before.result, after: after.result, customMismatches: mismatches })
      };
    });
  } catch (err) {
    if (err instanceof QueueWaitError) {
      throw new BridgeError({ kind: "queued", op_id: opId, message: err.message });
    }
    throw err;
  }
}
var AssetWatcher = class {
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.opts = opts;
  }
  timer = null;
  busy = false;
  failures = 0;
  skipUntil = 0;
  /** Files already imported or found in the project, per project, so they are not asked about again. */
  seen = /* @__PURE__ */ new Map();
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs ?? 5e3);
    this.timer.unref?.();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  /** One look at the asset folder; returns what it imported (for tests and the log). */
  async tick() {
    const settings = this.ctx.settings?.get().asset_watch;
    if (!settings?.enabled || this.busy) return null;
    if (this.ctx.quarantine.isQuarantined) return null;
    const clock = this.opts.now ?? Date.now;
    if (clock() < this.skipUntil) return null;
    this.busy = true;
    try {
      const out = await this.look(settings);
      if (this.failures > 0) {
        this.failures = 0;
        this.skipUntil = 0;
        this.opts.log?.("ok", "Asset watch is working again");
      }
      return out;
    } catch (err) {
      this.failures++;
      this.skipUntil = clock() + Math.min(BACKOFF_BASE_MS * Math.pow(2, this.failures - 1), BACKOFF_MAX_MS);
      if (this.failures === 1) this.opts.log?.("warn", `Asset watch: ${err instanceof Error ? err.message : String(err)} (retrying with backoff)`);
      return null;
    } finally {
      this.busy = false;
    }
  }
  async look(settings) {
    {
      const status = await this.ctx.bridge.evalRaw({
        id: `${this.ctx.bridge.newOpId()}_watch`,
        script: buildJsxCall("status", {}),
        label: "quiet: asset watch (status)",
        mutates: false,
        toolName: "asset_watch"
      });
      const projectPath = status.result?.project_path ?? "<unsaved>";
      if (projectPath === "<unsaved>") return null;
      const folder = path7.join(path7.dirname(projectPath), DEFAULT_ASSET_FOLDER);
      if (!fs6.existsSync(folder)) return null;
      const key = normalizeGuardPath(projectPath);
      const seen = this.seen.get(key) ?? /* @__PURE__ */ new Set();
      this.seen.set(key, seen);
      const since = settings.since ? Date.parse(settings.since) : 0;
      const candidates = scanAssets(folder, { recursive: settings.recursive, sequences: settings.sequences }).filter(
        (c) => !seen.has(normPath(c.path)) && c.arrivedMs >= since
      );
      if (candidates.length === 0) return null;
      const inProject = await readFootagePaths(this.ctx, "quiet: asset watch (footage)", "asset_watch");
      const now = (this.opts.now ?? Date.now)();
      const { fresh, already } = pickNewAssets(candidates, inProject.paths, now, SETTLE_MS, SEQUENCE_SETTLE_MS);
      for (const c of already) seen.add(normPath(c.path));
      if (fresh.length === 0) return null;
      const res = await importAssetFiles(this.ctx, projectPath, DEFAULT_ASSET_BIN, fresh.slice(0, MAX_IMPORT), "asset_watch");
      for (const i of res.imported) seen.add(normPath(i.path));
      for (const f of res.failed) seen.add(normPath(f.path));
      this.opts.log?.("ok", `Asset watch imported ${res.imported.length} file(s) into ${DEFAULT_ASSET_BIN}${res.failed.length ? `, ${res.failed.length} failed` : ""}`);
      return { imported: res.imported.length, failed: res.failed.length };
    }
  }
};
var assetsTools = [
  {
    name: "ae_import_assets",
    description: `Import staged assets: files in the asset folder (${DEFAULT_ASSET_FOLDER}/ next to the open .aep unless \`folder\` says otherwise) that are not in the project yet go into the ${DEFAULT_ASSET_BIN} bin, with subfolders mirrored and numbered stills (shot_0001.png ...; at least 3 frames, 3-7 digits, not v002-style versions) as one sequence, which waits until 10 s after its newest frame so a render in progress is not imported half-done. Save generated or delivered files (images, renders, voice-overs) there, then call this; files already in the project are skipped, and files still being written wait. \`watch: true\` turns on auto-import: files that arrive in ${DEFAULT_ASSET_FOLDER}/ next to whichever project is open are imported within seconds, until \`watch: false\` (turn it on only when the user wants it). The import is one undo group guarded by \`expect\`, with an auto checkpoint, and the bin is read back in a separate evalScript. ` + AGENT_SAFETY_GUIDANCE,
    schema: AeImportAssetsSchema,
    handler: async (args, ctx) => {
      const current = await readFootagePaths(ctx, "ae_import_assets (footage)", "ae_import_assets");
      const projectPath = current.project_path;
      if (normalizeGuardPath(args.expect.project_path) !== normalizeGuardPath(projectPath)) {
        return { ok: false, error: "guard", message: `The open project is ${projectPath}, not ${args.expect.project_path}. Re-read state; nothing was imported.` };
      }
      let watch;
      if (args.watch !== void 0) {
        if (!ctx.settings) return { ok: false, error: "no_settings", message: "This server has no settings store, so the watcher can't be set." };
        const prev = ctx.settings.get().asset_watch;
        let since = null;
        if (args.watch) since = prev.enabled && prev.since ? prev.since : (/* @__PURE__ */ new Date()).toISOString();
        const s = ctx.settings.updateAssetWatch({
          enabled: args.watch,
          since,
          recursive: args.recursive ?? true,
          sequences: args.sequences ?? true
        });
        watch = { ...s.asset_watch, folder: DEFAULT_ASSET_FOLDER, bin: DEFAULT_ASSET_BIN, note: args.watch ? "Files changed from now on are imported automatically." : "Auto-import is off." };
      }
      if (projectPath === "<unsaved>" && !args.folder) {
        return { ok: false, error: "unsaved_project", message: "The project has not been saved, so it has no asset folder. Save it, or pass an absolute folder.", watch };
      }
      const folder = args.folder ?? path7.join(path7.dirname(projectPath), DEFAULT_ASSET_FOLDER);
      if (!path7.isAbsolute(folder)) return { ok: false, error: "bad_args", message: `folder must be absolute: ${folder}` };
      if (!args.folder && (!args.dry_run || args.watch === true)) fs6.mkdirSync(folder, { recursive: true });
      const bin = args.bin ?? DEFAULT_ASSET_BIN;
      if (!fs6.existsSync(folder)) {
        if (args.dry_run) {
          return { ok: true, folder, bin, already_in_project: 0, still_writing: [], ...watch ? { watch } : {}, dry_run: true, to_import: [], imported: [], failed: [] };
        }
        return { ok: false, error: "not_found", message: `No such folder: ${folder}` };
      }
      const candidates = scanAssets(folder, { recursive: args.recursive, sequences: args.sequences });
      const { fresh, already, settling } = pickNewAssets(candidates, current.paths, Date.now(), SETTLE_MS, SEQUENCE_SETTLE_MS);
      const base = {
        ok: true,
        folder,
        bin,
        already_in_project: already.length,
        still_writing: settling.map((c) => c.path),
        ...watch ? { watch } : {}
      };
      if (args.dry_run || fresh.length === 0) {
        return {
          ...base,
          dry_run: args.dry_run === true,
          to_import: fresh.map((c) => ({ ...plan(c), frames: c.frames })),
          imported: [],
          failed: []
        };
      }
      if (fresh.length > MAX_IMPORT) {
        return { ok: false, error: "too_many", message: `${fresh.length} new files; import up to ${MAX_IMPORT} a call (use a subfolder as \`folder\`).` };
      }
      const res = await importAssetFiles(ctx, projectPath, bin, fresh, "ae_import_assets");
      return { ...base, ...res };
    }
  }
];

// src/tools/ext/diagnostics.ts
var fs8 = __toESM(require("node:fs"), 1);
var os2 = __toESM(require("node:os"), 1);
var path9 = __toESM(require("node:path"), 1);

// src/tools/ext/dialogs.ts
var import_node_child_process = require("node:child_process");
var fs7 = __toESM(require("node:fs"), 1);
var path8 = __toESM(require("node:path"), 1);
var url = __toESM(require("node:url"), 1);
var import_meta = {};
var JAY_DIALOG_RULES = "Jay's dialog rules: (1) Popups are NEVER suppressed (never call app.beginSuppressDialogs). (2) Answer ONLY dialogs that our own operation caused (caused_by_op is non-null), unless Jay gave an explicit user_instruction. (3) Destructive answers (Save, Don't Save, Replace, Delete, Overwrite, Discard, Remove, Revert) require BOTH allow_destructive: true AND a non-empty user_instruction quoting Jay's explicit instruction.";
var DESTRUCTIVE_BUTTON_PATTERN = /save|don't save|dont save|replace|delete|overwrite|discard|remove|revert/i;
var DIALOG_EXEC_TIMEOUT_MS = 15e3;
var MAX_DIALOG_TEXT_CHARS = 4e3;
var inFlightOps = [];
var seenDialogs = /* @__PURE__ */ new Map();
var runtimeOverrides = {};
function noteOpStarted(opId) {
  if (!opId || typeof opId !== "string") return;
  const existingIdx = inFlightOps.indexOf(opId);
  if (existingIdx !== -1) {
    inFlightOps.splice(existingIdx, 1);
  }
  inFlightOps.push(opId);
}
function noteOpFinished(opId) {
  if (!opId || typeof opId !== "string") return;
  const idx = inFlightOps.indexOf(opId);
  if (idx !== -1) {
    inFlightOps.splice(idx, 1);
  }
}
function getCurrentInFlightOp() {
  return inFlightOps.length > 0 ? inFlightOps[inFlightOps.length - 1] : null;
}
function currentPlatform() {
  return runtimeOverrides.platform ?? process.platform;
}
function dialogsSupported() {
  const p = currentPlatform();
  return p === "win32" || p === "darwin";
}
function currentNowIso() {
  return runtimeOverrides.nowIso ? runtimeOverrides.nowIso() : (/* @__PURE__ */ new Date()).toISOString();
}
function defaultDialogsDir() {
  if (runtimeOverrides.dialogsDir) {
    return runtimeOverrides.dialogsDir;
  }
  return path8.join(defaultDataDir(), "dialogs");
}
function getRuntimeBaseDir() {
  try {
    if (typeof __dirname === "string" && __dirname.length > 0) {
      return __dirname;
    }
  } catch {
  }
  try {
    if (typeof import_meta?.url === "string" && import_meta.url.startsWith("file:")) {
      return path8.dirname(url.fileURLToPath(import_meta.url));
    }
  } catch {
  }
  return process.cwd();
}
function locateDialogsPs1Script(startDir) {
  if (runtimeOverrides.scriptPath !== void 0) {
    return runtimeOverrides.scriptPath;
  }
  return locateToolScript("ae-dialogs.ps1", startDir);
}
function locateToolScript(fileName, startDir) {
  const rootsToSearch = [startDir ?? getRuntimeBaseDir(), process.cwd()];
  const visited = /* @__PURE__ */ new Set();
  for (const start of rootsToSearch) {
    let dir = path8.resolve(start);
    while (!visited.has(dir)) {
      visited.add(dir);
      const candidateA = path8.join(dir, "panel", "tools", fileName);
      if (fs7.existsSync(candidateA)) {
        return candidateA;
      }
      const candidateB = path8.join(dir, "tools", fileName);
      if (fs7.existsSync(candidateB)) {
        return candidateB;
      }
      const parent = path8.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}
function parsePs1JsonOutput(stdout) {
  const trimmed = (stdout ?? "").trim();
  if (!trimmed) {
    return {
      ok: false,
      error: "empty_ps1_output"
    };
  }
  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && typeof parsed === "object" && typeof parsed.ok === "boolean") {
        return parsed;
      }
    } catch {
    }
  }
  try {
    const parsedWhole = JSON.parse(trimmed);
    if (parsedWhole && typeof parsedWhole === "object" && typeof parsedWhole.ok === "boolean") {
      return parsedWhole;
    }
  } catch {
  }
  return {
    ok: false,
    error: `invalid_ps1_json: ${trimmed.slice(0, 200)}`
  };
}
function normalizeRawDialog(raw, meta) {
  const rawText = typeof raw.text === "string" ? raw.text : "";
  const boundedText = rawText.length > MAX_DIALOG_TEXT_CHARS ? rawText.slice(0, MAX_DIALOG_TEXT_CHARS) : rawText;
  const rawButtons = Array.isArray(raw.buttons) ? raw.buttons : [];
  const buttons = rawButtons.map((b) => ({
    name: typeof b?.name === "string" ? b.name : "",
    automationId: typeof b?.automationId === "string" ? b.automationId : "",
    enabled: Boolean(b?.enabled ?? true)
  }));
  const rawCheckboxes = Array.isArray(raw.checkboxes) ? raw.checkboxes : [];
  const checkboxes = rawCheckboxes.map((c) => ({
    name: typeof c?.name === "string" ? c.name : "",
    checked: Boolean(c?.checked)
  }));
  const r = raw.boundingRect ?? raw.rect ?? {};
  const boundingRect = {
    x: typeof r.x === "number" ? r.x : 0,
    y: typeof r.y === "number" ? r.y : 0,
    width: typeof r.width === "number" ? r.width : 0,
    height: typeof r.height === "number" ? r.height : 0
  };
  return {
    handle: Number(raw.handle),
    title: typeof raw.title === "string" ? raw.title : "",
    class: typeof raw.class === "string" ? raw.class : "",
    isModal: Boolean(raw.isModal),
    text: boundedText,
    buttons,
    checkboxes,
    boundingRect,
    screenshot: typeof raw.screenshot === "string" ? raw.screenshot : null,
    first_seen: meta.first_seen,
    caused_by_op: meta.caused_by_op
  };
}
function enrichDialogsList(rawDialogs) {
  const activeHandles = /* @__PURE__ */ new Set();
  const now = currentNowIso();
  const inFlight = getCurrentInFlightOp();
  const result = [];
  for (const raw of rawDialogs) {
    const handle = Number(raw?.handle);
    if (!Number.isFinite(handle) || handle <= 0) continue;
    activeHandles.add(handle);
    let meta = seenDialogs.get(handle);
    const title = typeof raw.title === "string" ? raw.title : "";
    const text = typeof raw.text === "string" ? raw.text.slice(0, MAX_DIALOG_TEXT_CHARS) : "";
    if (!meta) {
      meta = {
        handle,
        first_seen: now,
        caused_by_op: inFlight,
        title,
        text
      };
      seenDialogs.set(handle, meta);
    } else {
      if (title) meta.title = title;
      if (text) meta.text = text;
    }
    result.push(normalizeRawDialog(raw, meta));
  }
  for (const existingHandle of Array.from(seenDialogs.keys())) {
    if (!activeHandles.has(existingHandle)) {
      seenDialogs.delete(existingHandle);
    }
  }
  return result;
}
function runPowerShellScript(ps1Args) {
  if (runtimeOverrides.ps1Runner) {
    return runtimeOverrides.ps1Runner(ps1Args);
  }
  const scriptPath = locateDialogsPs1Script();
  if (!scriptPath) {
    return Promise.resolve(
      JSON.stringify({
        ok: false,
        error: "ae_dialogs_ps1_not_found"
      })
    );
  }
  const fullArgs = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    ...ps1Args
  ];
  return new Promise((resolve2) => {
    (0, import_node_child_process.execFile)(
      "powershell.exe",
      fullArgs,
      {
        windowsHide: true,
        timeout: DIALOG_EXEC_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024
      },
      (err, stdout, stderr) => {
        const outStr = typeof stdout === "string" ? stdout.trim() : "";
        if (outStr.length > 0) {
          resolve2(outStr);
          return;
        }
        const errMsg = err instanceof Error ? err.message : typeof stderr === "string" && stderr.trim().length > 0 ? stderr.trim() : "powershell_exec_failed";
        resolve2(
          JSON.stringify({
            ok: false,
            error: errMsg
          })
        );
      }
    );
  });
}
function runMacScript(args) {
  if (runtimeOverrides.macRunner) {
    return runtimeOverrides.macRunner(args);
  }
  const scriptPath = locateToolScript("ae-dialogs-mac.js");
  if (!scriptPath) {
    return Promise.resolve(JSON.stringify({ ok: false, error: "ae_dialogs_mac_script_not_found" }));
  }
  return new Promise((resolve2) => {
    (0, import_node_child_process.execFile)(
      "osascript",
      ["-l", "JavaScript", scriptPath, ...args],
      { timeout: DIALOG_EXEC_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const outStr = typeof stdout === "string" ? stdout.trim() : "";
        if (outStr.length > 0) {
          resolve2(outStr);
          return;
        }
        const errMsg = typeof stderr === "string" && stderr.trim().length > 0 ? stderr.trim() : err instanceof Error ? err.message : "osascript_exec_failed";
        resolve2(JSON.stringify({ ok: false, error: errMsg }));
      }
    );
  });
}
function isDestructiveButton(buttonName) {
  return DESTRUCTIVE_BUTTON_PATTERN.test(buttonName ?? "");
}
function evaluateRespondPolicy(params) {
  const hasUserInstruction = typeof params.user_instruction === "string" && params.user_instruction.trim().length > 0;
  if (params.caused_by_op === null && !hasUserInstruction) {
    return {
      allowed: false,
      error: "refused_not_caused_by_our_op",
      message: "Refused to respond to dialog: caused_by_op is null (dialog was not caused by our own in-flight operation) and no non-empty user_instruction quoting Jay was provided."
    };
  }
  if (isDestructiveButton(params.button)) {
    if (params.allow_destructive !== true || !hasUserInstruction) {
      return {
        allowed: false,
        error: "refused_destructive_button",
        message: `Refused to click destructive button "${params.button}": buttons matching ${DESTRUCTIVE_BUTTON_PATTERN.toString()} require BOTH allow_destructive: true AND a non-empty user_instruction quoting Jay's explicit instruction.`
      };
    }
  }
  return { allowed: true };
}
function appendResponseLog(entry) {
  const dir = defaultDialogsDir();
  fs7.mkdirSync(dir, { recursive: true });
  const logFile = path8.join(dir, "responses.jsonl");
  fs7.appendFileSync(logFile, `${JSON.stringify(entry)}
`, {
    encoding: "utf8"
  });
}
async function listDialogsInternal(opts) {
  if (!dialogsSupported()) {
    return {
      ok: false,
      error: "not_implemented_on_this_os"
    };
  }
  if (currentPlatform() === "darwin") {
    const macParsed = parsePs1JsonOutput(await runMacScript(["list"]));
    if (!macParsed.ok) {
      return { ok: false, error: macParsed.error || "dialog_list_failed" };
    }
    return {
      ok: true,
      ae_pid: macParsed.ae_pid ?? null,
      dialogs: enrichDialogsList(Array.isArray(macParsed.dialogs) ? macParsed.dialogs : [])
    };
  }
  const psArgs = ["-Mode", "list"];
  if (opts.screenshots) {
    const dir = defaultDialogsDir();
    fs7.mkdirSync(dir, { recursive: true });
    psArgs.push("-ScreenshotDir", dir);
  }
  const rawStdout = await runPowerShellScript(psArgs);
  const parsed = parsePs1JsonOutput(rawStdout);
  if (!parsed.ok) {
    return {
      ok: false,
      error: parsed.error || "dialog_list_failed"
    };
  }
  const rawList = Array.isArray(parsed.dialogs) ? parsed.dialogs : [];
  const enriched = enrichDialogsList(rawList);
  return {
    ok: true,
    ae_pid: parsed.ae_pid ?? null,
    dialogs: enriched
  };
}
async function describeBlockingDialogs() {
  try {
    const res = await listDialogsInternal({ screenshots: true });
    if (!res.ok) {
      return [];
    }
    return res.dialogs;
  } catch {
    return [];
  }
}
var AeDialogsSchema = external_exports.object({
  screenshots: external_exports.boolean().default(true).optional().describe(
    "Whether to capture a PNG screenshot of each open dialog into %LOCALAPPDATA%/chroma-ae-mcp/dialogs/ (default: true)."
  )
});
var AeDialogRespondSchema = external_exports.object({
  handle: external_exports.number().int().positive().describe("NativeWindowHandle (HWND) of the dialog to respond to."),
  button: external_exports.string().min(1).describe(
    "Exact button name (case-insensitive) to press via UIA InvokePattern."
  ),
  check: external_exports.string().min(1).optional().describe(
    "Optional checkbox name to toggle on before pressing the button."
  ),
  reason: external_exports.string().min(1).describe(
    "Clear explanation of why this dialog is being answered and why this button was chosen."
  ),
  allow_destructive: external_exports.boolean().default(false).optional().describe(
    "Must be true (along with user_instruction) to press destructive buttons matching /save|don't save|dont save|replace|delete|overwrite|discard|remove|revert/i."
  ),
  user_instruction: external_exports.string().optional().describe(
    "Verbatim quote of Jay's explicit instruction authorizing answering an external dialog or pressing a destructive button."
  )
});
var dialogsTools = [
  {
    name: "ae_dialogs",
    description: `READ-ONLY. Lists modal/popup dialogs currently open in After Effects from outside AE's blocked ExtendScript thread (Windows: UI Automation; macOS: System Events, which needs Accessibility permission for After Effects and gives no screenshots), returning handle, title, class, text, buttons, checkboxes, boundingRect, screenshot path (in %LOCALAPPDATA%/chroma-ae-mcp/dialogs/), first_seen, and caused_by_op. AE paints many dialogs itself, so UI Automation sees no text or buttons in them; then text and button labels come from OCR of the screenshot (text_source: "ocr", which may contain small misreads such as 0K for OK). Look at the screenshot when in doubt. ` + JAY_DIALOG_RULES + " " + AGENT_SAFETY_GUIDANCE,
    schema: AeDialogsSchema,
    handler: async (args) => {
      if (!dialogsSupported()) {
        return {
          ok: false,
          error: "not_implemented_on_this_os"
        };
      }
      const screenshots = args.screenshots ?? true;
      return await listDialogsInternal({ screenshots });
    }
  },
  {
    name: "ae_dialog_respond",
    description: "Responds to an open After Effects modal dialog by its handle using Windows UI Automation, or on macOS the button's AXPress through System Events (never brings windows to the foreground or moves the mouse; on macOS the handle is window index * 100 + sheet index and the dialog's title must be unchanged). For AE-painted dialogs (OCR buttons), only two answers are possible without focusing AE: Cancel/No/Close (sent as Escape) and OK/Yes/Continue when it is the dialog's ONLY button (sent as Enter). Anything else returns button_not_answerable: ask Jay to answer it. Logs every response to %LOCALAPPDATA%/chroma-ae-mcp/dialogs/responses.jsonl. " + JAY_DIALOG_RULES + " " + AGENT_SAFETY_GUIDANCE,
    schema: AeDialogRespondSchema,
    handler: async (args) => {
      if (!dialogsSupported()) {
        return {
          ok: false,
          error: "not_implemented_on_this_os"
        };
      }
      let meta = seenDialogs.get(args.handle);
      if (!meta) {
        await listDialogsInternal({ screenshots: false });
        meta = seenDialogs.get(args.handle);
      }
      const causedByOp = meta ? meta.caused_by_op : getCurrentInFlightOp();
      const policy = evaluateRespondPolicy({
        button: args.button,
        caused_by_op: causedByOp,
        allow_destructive: args.allow_destructive ?? false,
        user_instruction: args.user_instruction
      });
      if (!policy.allowed) {
        return {
          ok: false,
          error: policy.error ?? "refused_by_policy",
          message: policy.message,
          handle: args.handle,
          button: args.button,
          caused_by_op: causedByOp
        };
      }
      let rawStdout;
      if (currentPlatform() === "darwin") {
        rawStdout = await runMacScript(["respond", String(args.handle), args.button, args.check ?? "", meta?.title ?? "", (meta?.text ?? "").slice(0, 200)]);
      } else {
        const psArgs = [
          "-Mode",
          "respond",
          "-Handle",
          String(args.handle),
          "-Button",
          args.button
        ];
        if (args.check) {
          psArgs.push("-Check", args.check);
        }
        rawStdout = await runPowerShellScript(psArgs);
      }
      const parsed = parsePs1JsonOutput(rawStdout);
      const logTime = currentNowIso();
      const title = meta?.title ?? "";
      const textExcerpt = (meta?.text ?? "").slice(0, 500);
      appendResponseLog({
        time: logTime,
        handle: args.handle,
        title,
        text_excerpt: textExcerpt,
        button: args.button,
        check: args.check,
        reason: args.reason,
        op: causedByOp,
        allow_destructive: Boolean(args.allow_destructive),
        user_instruction: args.user_instruction,
        result: parsed
      });
      if (parsed.ok && parsed.closed) {
        seenDialogs.delete(args.handle);
      }
      return parsed;
    }
  }
];

// src/tools/ext/diagnostics.ts
var AE_STATUS_WAIT_MS = 5e3;
var DEFAULT_LOG_LINES = 300;
var AeDiagnosticsSchema = external_exports.object({
  log_lines: external_exports.number().int().min(0).max(5e3).optional().describe(`Lines from the end of the service log. Default ${DEFAULT_LOG_LINES}.`),
  include_dialogs: external_exports.boolean().optional().describe("Read AE's open popups (Windows and macOS; default true).")
});
function redact(text, secret) {
  let out = text.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]");
  if (secret && secret.length >= 8) out = out.split(secret).join("[redacted]");
  return out;
}
function tailLines(text, n) {
  if (n <= 0) return "";
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-n).join("\n");
}
function readIfExists(p) {
  if (!p) return "";
  try {
    return fs8.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}
var pendingStatus = /* @__PURE__ */ new WeakMap();
async function aeStatusWithin(ctx, ms) {
  let call = pendingStatus.get(ctx);
  if (!call) {
    call = ctx.bridge.evalRaw({
      id: `${ctx.bridge.newOpId()}_diag`,
      script: buildJsxCall("status", {}),
      label: "ae_diagnostics (status)",
      mutates: false,
      toolName: "ae_diagnostics"
    }).then((r) => ({ answered: true, status: r.result })).catch((err) => ({ answered: true, error: err instanceof Error ? err.message : String(err) }));
    const mine = call;
    pendingStatus.set(ctx, mine);
    void mine.then(() => {
      if (pendingStatus.get(ctx) === mine) pendingStatus.delete(ctx);
    });
  }
  let timer;
  const late2 = new Promise((resolve2) => {
    timer = setTimeout(
      () => resolve2({ answered: false, error: `AE did not answer within ${ms / 1e3} s (busy with a script or render, or a popup is open).` }),
      ms
    );
  });
  try {
    return await Promise.race([call, late2]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function writeDiagnostics(ctx, serviceInfo, opts = {}) {
  const now = /* @__PURE__ */ new Date();
  const token = readIfExists(serviceInfo?.tokenPath).trim() || null;
  const ae = await aeStatusWithin(ctx, opts.aeWaitMs ?? AE_STATUS_WAIT_MS);
  const dialogs = opts.includeDialogs === false ? [] : await describeBlockingDialogs();
  const quarantine = ctx.quarantine.list();
  const logText = readIfExists(serviceInfo?.rotatedLogPath) + readIfExists(serviceInfo?.logPath);
  const log = redact(tailLines(logText, opts.logLines ?? DEFAULT_LOG_LINES), token);
  const { tokenPath: _omit, ...service } = serviceInfo ?? {};
  const summary2 = {
    created_at: now.toISOString(),
    ae_answered: ae.answered,
    service_in_flight: service.inFlight ?? null,
    write_queue: { depth: ctx.queue.depth, in_flight: ctx.queue.inFlight },
    quarantined: quarantine.length,
    open_dialogs: dialogs.length
  };
  const sections = [
    ["Summary", summary2],
    ["Service", service],
    ["After Effects", ae],
    ["Quarantine", quarantine],
    ["Settings", ctx.settings?.get() ?? null],
    ["Open popups", dialogs.map((d) => ({ ...d, screenshot_path: d.screenshot_path }))],
    ["System", { platform: process.platform, release: os2.release(), arch: process.arch, node: process.version }]
  ];
  const md = [
    `# chroma-ae-mcp diagnostics, ${now.toISOString()}`,
    "",
    "The token is not included. Attach this file when reporting a problem.",
    "",
    ...sections.flatMap(([title, value]) => [`## ${title}`, "", "```json", redact(JSON.stringify(value, null, 2), token), "```", ""]),
    `## Service log (last ${opts.logLines ?? DEFAULT_LOG_LINES} lines)`,
    "",
    "```",
    log,
    "```",
    ""
  ].join("\n");
  const dir = path9.join(dataDirOf(ctx), "diagnostics");
  fs8.mkdirSync(dir, { recursive: true });
  const stem = `chroma-ae-diagnostics_${formatBackupTimestamp(now)}`;
  let file = path9.join(dir, `${stem}.md`);
  for (let n = 2; ; n++) {
    try {
      fs8.writeFileSync(file, md, { encoding: "utf8", flag: "wx" });
      break;
    } catch (err) {
      if (err.code !== "EEXIST" || n > 1e3) throw err;
      file = path9.join(dir, `${stem}-${n}.md`);
    }
  }
  return { path: file, summary: summary2 };
}
var diagnosticsTools = [
  {
    name: "ae_diagnostics",
    description: "Write a diagnostics file for triage when automation is stuck or failing: versions, the service's eval queue and what is in flight (and for how long), the write queue, quarantine, settings, AE's status (if AE answers within 5 s; nothing is aborted), AE's open popups, and the end of the service log. The token is redacted. Returns the file's path and a summary; the user can attach the file to a bug report. Never touches the AE project.",
    schema: AeDiagnosticsSchema,
    handler: async (args, ctx) => {
      const res = await writeDiagnostics(ctx, ctx.serviceInfo?.(), { logLines: args.log_lines, includeDialogs: args.include_dialogs });
      return { ok: true, ...res };
    }
  }
];

// src/panel-entry.ts
var path22 = __toESM(require("node:path"), 1);

// src/schema.ts
function zodToJsonSchema(schema) {
  let current = schema;
  while (current instanceof external_exports.ZodEffects || current instanceof external_exports.ZodDefault || current instanceof external_exports.ZodOptional) {
    if (current instanceof external_exports.ZodEffects) {
      current = current._def.schema;
    } else if (current instanceof external_exports.ZodDefault) {
      current = current._def.innerType;
    } else if (current instanceof external_exports.ZodOptional) {
      current = current._def.innerType;
    }
  }
  if (!(current instanceof external_exports.ZodObject)) {
    return { type: "object", properties: {} };
  }
  const shape = current.shape;
  const properties = {};
  const required = [];
  for (const [key, fieldSchema] of Object.entries(shape)) {
    const { propSchema, isOptional } = convertFieldSchema(fieldSchema);
    properties[key] = propSchema;
    if (!isOptional) {
      required.push(key);
    }
  }
  const out = {
    type: "object",
    properties
  };
  if (required.length > 0) {
    out.required = required;
  }
  return out;
}
function convertFieldSchema(schema) {
  let isOptional = false;
  let current = schema;
  let description = current.description;
  while (current instanceof external_exports.ZodOptional || current instanceof external_exports.ZodDefault || current instanceof external_exports.ZodEffects) {
    if (!description && current.description) {
      description = current.description;
    }
    if (current instanceof external_exports.ZodOptional || current instanceof external_exports.ZodDefault) {
      isOptional = true;
      current = current._def.innerType;
    } else if (current instanceof external_exports.ZodEffects) {
      current = current._def.schema;
    }
  }
  if (!description && current.description) {
    description = current.description;
  }
  let propSchema = {};
  if (current instanceof external_exports.ZodString) {
    propSchema = { type: "string" };
  } else if (current instanceof external_exports.ZodNumber) {
    propSchema = { type: "number" };
  } else if (current instanceof external_exports.ZodBoolean) {
    propSchema = { type: "boolean" };
  } else if (current instanceof external_exports.ZodEnum) {
    propSchema = { type: "string", enum: current._def.values };
  } else if (current instanceof external_exports.ZodArray) {
    const elem = convertFieldSchema(current._def.type);
    propSchema = { type: "array", items: elem.propSchema };
  } else if (current instanceof external_exports.ZodObject) {
    propSchema = zodToJsonSchema(current);
  } else {
    propSchema = {};
  }
  if (description) {
    propSchema.description = description;
  }
  return { propSchema, isOptional };
}

// src/tools/ext/aerender.ts
var childProcess = __toESM(require("node:child_process"), 1);
var crypto = __toESM(require("node:crypto"), 1);
var fs9 = __toESM(require("node:fs"), 1);
var path10 = __toESM(require("node:path"), 1);
var WINDOWS_FALLBACK_AERENDER = "C:/Program Files/Adobe/Adobe After Effects 2026/Support Files/aerender.exe";
var MACOS_FALLBACK_AERENDER = "/Applications/Adobe After Effects 2026/aerender";
function defaultRendersDir() {
  return path10.join(defaultDataDir(), "renders");
}
function defaultAerenderJobsFilePath() {
  return path10.join(defaultRendersDir(), "jobs.json");
}
function resolveAerenderPath(options) {
  const platform = options?.platform ?? process.platform;
  const exists = options?.existsSync ?? fs9.existsSync;
  const afterFxPath = options?.afterFxPath?.trim();
  let versionYear = null;
  if (options?.aeVersion) {
    const m = /^(\d+)/.exec(options.aeVersion.trim());
    if (m) {
      const major = parseInt(m[1], 10);
      if (major >= 20 && major <= 40) {
        versionYear = 2e3 + major;
      }
    }
  }
  if (platform === "darwin") {
    if (afterFxPath) {
      const norm = afterFxPath.replace(/\\/g, "/");
      const appIdx = norm.toLowerCase().indexOf(".app");
      if (appIdx !== -1) {
        const appBundlePath = norm.slice(0, appIdx + 4);
        const parentDir = path10.posix.dirname(appBundlePath);
        const candidate2 = path10.posix.join(parentDir, "aerender");
        if (exists(candidate2)) {
          return candidate2;
        }
        return candidate2;
      }
      const dir = path10.posix.dirname(norm);
      const candidate = path10.posix.join(dir, "aerender");
      if (exists(candidate)) {
        return candidate;
      }
    }
    const years2 = versionYear ? [versionYear, 2026, 2025, 2024] : [2026, 2025, 2024];
    for (const yr of years2) {
      const appParent = `/Applications/Adobe After Effects ${yr}`;
      const candidate = `${appParent}/aerender`;
      if (exists(candidate)) {
        return candidate;
      }
    }
    return MACOS_FALLBACK_AERENDER;
  }
  if (afterFxPath) {
    const norm = afterFxPath.replace(/\\/g, "/");
    const dir = norm.toLowerCase().endsWith(".exe") ? path10.posix.dirname(norm) : norm.replace(/\/+$/, "");
    const candidate = `${dir}/aerender.exe`;
    if (exists(candidate)) {
      return candidate;
    }
    return candidate;
  }
  if (typeof process.execPath === "string" && process.execPath.length > 0) {
    const execDir = path10.dirname(process.execPath).replace(/\\/g, "/");
    if (exists(`${execDir}/AfterFX.exe`) && exists(`${execDir}/aerender.exe`)) {
      return `${execDir}/aerender.exe`;
    }
  }
  const years = versionYear ? [versionYear, 2026, 2025, 2024] : [2026, 2025, 2024];
  for (const yr of years) {
    const supportDir = `C:/Program Files/Adobe/Adobe After Effects ${yr}/Support Files`;
    const candidate = `${supportDir}/aerender.exe`;
    if (exists(`${supportDir}/AfterFX.exe`) || exists(candidate)) {
      return candidate;
    }
  }
  return WINDOWS_FALLBACK_AERENDER;
}
function buildAerenderArgs(params) {
  const cliArgs = [
    "-project",
    params.project_path,
    "-comp",
    params.comp_name,
    "-output",
    params.output_path
  ];
  if (params.render_settings_template) {
    cliArgs.push("-RStemplate", params.render_settings_template);
  }
  if (params.output_module_template) {
    cliArgs.push("-OMtemplate", params.output_module_template);
  }
  if (params.start_frame !== void 0) {
    cliArgs.push("-s", String(params.start_frame));
  }
  if (params.end_frame !== void 0) {
    cliArgs.push("-e", String(params.end_frame));
  }
  return cliArgs;
}
function parseAerenderProgress(logText, meta) {
  const lines = logText.split(/\r?\n/);
  const renderedFrames = [];
  const seenFrames = /* @__PURE__ */ new Set();
  let progressLinesCount = 0;
  let lastProgressLine = null;
  let inferredTotalFrames = null;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!/^PROGRESS:/i.test(line)) {
      continue;
    }
    progressLinesCount++;
    lastProgressLine = line;
    const parenMatch = /^PROGRESS:\s*(?:[0-9:;.]+\s*)?\((\d+)\)\s*:/i.exec(
      line
    );
    if (parenMatch) {
      const frameNum = parseInt(parenMatch[1], 10);
      if (!Number.isNaN(frameNum)) {
        renderedFrames.push(frameNum);
        seenFrames.add(frameNum);
      }
      continue;
    }
    const fracMatch = /^PROGRESS:\s*(?:frame\s+(\d+)\s+of\s+(\d+)|(\d+)\s*\/\s*(\d+))\s*$/i.exec(line);
    if (fracMatch) {
      const frameNum = parseInt(fracMatch[1] ?? fracMatch[3], 10);
      const totalNum = parseInt(fracMatch[2] ?? fracMatch[4], 10);
      if (!Number.isNaN(frameNum)) {
        renderedFrames.push(frameNum);
        seenFrames.add(frameNum);
      }
      if (!Number.isNaN(totalNum) && totalNum > 0) {
        inferredTotalFrames = totalNum;
      }
    }
  }
  const currentFrame = renderedFrames.length > 0 ? renderedFrames[renderedFrames.length - 1] : null;
  const startFrame = meta?.start_frame !== void 0 ? meta.start_frame : renderedFrames.length > 0 ? renderedFrames[0] : null;
  const endFrame = meta?.end_frame !== void 0 ? meta.end_frame : null;
  const totalFrames = meta?.start_frame !== void 0 && meta?.end_frame !== void 0 && meta.end_frame >= meta.start_frame ? meta.end_frame - meta.start_frame + 1 : inferredTotalFrames;
  const framesCompleted = seenFrames.size;
  let percent = null;
  if (totalFrames !== null && totalFrames > 0) {
    if (meta?.state === "succeeded") {
      percent = 100;
    } else if (currentFrame !== null && startFrame !== null && currentFrame >= startFrame) {
      const doneBySpan = Math.max(
        framesCompleted,
        currentFrame - startFrame + 1
      );
      percent = Math.min(
        100,
        Math.max(0, Math.round(doneBySpan / totalFrames * 1e4) / 100)
      );
    } else {
      percent = Math.min(
        100,
        Math.max(0, Math.round(framesCompleted / totalFrames * 1e4) / 100)
      );
    }
  } else if (meta?.state === "succeeded") {
    percent = 100;
  }
  return {
    current_frame: currentFrame,
    last_frame: currentFrame,
    frames_completed: framesCompleted,
    start_frame: startFrame,
    end_frame: endFrame,
    total_frames: totalFrames,
    percent,
    progress_lines_count: progressLinesCount,
    last_progress_line: lastProgressLine
  };
}
function readLogTail(logPath, maxLines = 60, maxChars = 16e3) {
  try {
    if (!fs9.existsSync(logPath)) {
      return { fullText: "", tail: "" };
    }
    const fullText = fs9.readFileSync(logPath, "utf8");
    const lines = fullText.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }
    const tailLines2 = lines.slice(-maxLines);
    let tail = tailLines2.join("\n");
    if (tail.length > maxChars) {
      tail = tail.slice(-maxChars);
    }
    return { fullText, tail };
  } catch {
    return { fullText: "", tail: "" };
  }
}
var AerenderJobRegistry = class {
  filePath;
  jobs = /* @__PURE__ */ new Map();
  procs = /* @__PURE__ */ new Map();
  constructor(filePath = defaultAerenderJobsFilePath()) {
    this.filePath = filePath;
    this.loadFromDisk();
  }
  get path() {
    return this.filePath;
  }
  get rendersDir() {
    return path10.dirname(this.filePath);
  }
  newJobId() {
    return `job_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  }
  list() {
    return Array.from(this.jobs.values());
  }
  get(jobId) {
    return this.jobs.get(jobId);
  }
  getProcess(jobId) {
    return this.procs.get(jobId);
  }
  register(record, proc) {
    this.jobs.set(record.job_id, { ...record });
    if (proc) {
      this.procs.set(record.job_id, proc);
    }
    this.saveToDisk();
    return this.jobs.get(record.job_id);
  }
  update(jobId, patch) {
    const existing = this.jobs.get(jobId);
    if (!existing) {
      return void 0;
    }
    const updated = {
      ...existing,
      ...patch,
      job_id: existing.job_id
    };
    this.jobs.set(jobId, updated);
    if (updated.state !== "running") {
      this.procs.delete(jobId);
    }
    this.saveToDisk();
    return updated;
  }
  loadFromDisk() {
    try {
      if (!fs9.existsSync(this.filePath)) {
        return;
      }
      const raw = fs9.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && Array.isArray(parsed.jobs) ? parsed.jobs : [];
      for (const item of list) {
        if (item && typeof item === "object" && typeof item.job_id === "string") {
          const rec = item;
          this.jobs.set(rec.job_id, { ...rec });
        }
      }
    } catch {
    }
  }
  saveToDisk() {
    const dir = path10.dirname(this.filePath);
    fs9.mkdirSync(dir, { recursive: true });
    const payload = JSON.stringify({ jobs: this.list() }, null, 2);
    const tmpFile = `${this.filePath}.tmp-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
    try {
      fs9.writeFileSync(tmpFile, payload, { encoding: "utf8" });
      fs9.renameSync(tmpFile, this.filePath);
    } catch {
      fs9.writeFileSync(this.filePath, payload, { encoding: "utf8" });
      try {
        if (fs9.existsSync(tmpFile)) fs9.unlinkSync(tmpFile);
      } catch {
      }
    }
  }
};
var defaultRegistry = null;
function getDefaultAerenderRegistry() {
  if (!defaultRegistry) {
    defaultRegistry = new AerenderJobRegistry();
  }
  return defaultRegistry;
}
var AeAerenderStartSchema = external_exports.object({
  expect: ExpectSchema,
  comp_name: external_exports.string().min(1).describe("Name of the composition to render."),
  output_path: external_exports.string().min(1).describe("Absolute output file path for aerender (-output)."),
  output_module_template: external_exports.string().min(1).optional().describe("Optional Output Module template name (-OMtemplate)."),
  render_settings_template: external_exports.string().min(1).optional().describe("Optional Render Settings template name (-RStemplate)."),
  start_frame: external_exports.number().int().min(0).optional().describe("Optional start frame index (-s)."),
  end_frame: external_exports.number().int().min(0).optional().describe("Optional end frame index (-e).")
}).superRefine((val, ctx) => {
  if (val.start_frame !== void 0 && val.end_frame !== void 0 && val.end_frame < val.start_frame) {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      path: ["end_frame"],
      message: "`end_frame` must be >= `start_frame`."
    });
  }
});
var AeAerenderStatusSchema = external_exports.object({
  job_id: external_exports.string().min(1).describe("Background aerender job ID.")
});
var AeAerenderCancelSchema = external_exports.object({
  job_id: external_exports.string().min(1).describe("Background aerender job ID to cancel.")
});
function createAerenderTools(options = {}) {
  const getRegistry = () => options.registry ?? getDefaultAerenderRegistry();
  const spawnFn = options.spawn ?? childProcess.spawn;
  return [
    {
      name: "ae_aerender_start",
      description: "Start a background `aerender` process (`windowsHide: true`, detached) for a saved, non-dirty After Effects project, logging stdout/stderr to `%LOCALAPPDATA%\\chroma-ae-mcp\\renders\\<job>.log` and tracking the job in a JSON-mirrored registry. " + AGENT_SAFETY_GUIDANCE,
      schema: AeAerenderStartSchema,
      handler: async (args, ctx) => {
        ctx.quarantine.assertClear();
        const opId = ctx.bridge.newOpId();
        const registry = getRegistry();
        try {
          return await ctx.queue.run(
            `ae_aerender_start(${args.comp_name})`,
            async () => {
              ctx.quarantine.assertClear();
              const statusResp = await ctx.bridge.evalRaw({
                id: `${opId}_status`,
                script: buildJsxCall("status", {}),
                label: "ae_aerender_start (status)",
                mutates: false,
                toolName: "ae_aerender_start"
              });
              const statusInfo = statusResp.result ?? {};
              const actualProjectPath = statusInfo.project_path ?? "<unsaved>";
              if (actualProjectPath === "<unsaved>" || args.expect.project_path === "<unsaved>") {
                throw new BridgeError({
                  kind: "guard",
                  op_id: opId,
                  message: "Cannot start aerender on an unsaved project (<unsaved>). Save the project to disk first.",
                  expected: {
                    project_path: args.expect.project_path,
                    dirty: false
                  },
                  actual: {
                    project_path: actualProjectPath,
                    dirty: Boolean(statusInfo.dirty)
                  }
                });
              }
              if (!pathsMatchForGuard(
                args.expect.project_path,
                actualProjectPath
              )) {
                throw new BridgeError({
                  kind: "guard",
                  op_id: opId,
                  message: `Target guard refused ae_aerender_start: expected project_path "${args.expect.project_path}", but After Effects has "${actualProjectPath}" open.`,
                  expected: args.expect,
                  actual: {
                    project_path: actualProjectPath,
                    dirty: Boolean(statusInfo.dirty)
                  }
                });
              }
              if (statusInfo.dirty === true) {
                throw new BridgeError({
                  kind: "guard",
                  op_id: opId,
                  message: "Cannot start aerender because the open project has unsaved changes (dirty: true). Call ae_save first so aerender renders the latest state on disk.",
                  expected: {
                    project_path: args.expect.project_path,
                    dirty: false
                  },
                  actual: {
                    project_path: actualProjectPath,
                    dirty: true
                  }
                });
              }
              if (args.expect.comp_id !== void 0) {
                await verifyTargetGuard(ctx, args.expect, opId);
              }
              const aerenderBin = resolveAerenderPath({
                platform: options.platform,
                afterFxPath: options.afterFxPath ?? statusInfo.afterfx_path ?? statusInfo.app_path,
                aeVersion: statusInfo.aeVersion,
                existsSync: options.existsSync
              });
              const jobId = registry.newJobId();
              const rendersDir = registry.rendersDir;
              fs9.mkdirSync(rendersDir, { recursive: true });
              const outDir = path10.dirname(args.output_path);
              if (outDir && outDir !== ".") {
                try {
                  fs9.mkdirSync(outDir, { recursive: true });
                } catch {
                }
              }
              const logPath = path10.join(rendersDir, `${jobId}.log`);
              fs9.writeFileSync(logPath, "", { encoding: "utf8" });
              const cliArgs = buildAerenderArgs({
                project_path: actualProjectPath,
                comp_name: args.comp_name,
                output_path: args.output_path,
                output_module_template: args.output_module_template,
                render_settings_template: args.render_settings_template,
                start_frame: args.start_frame,
                end_frame: args.end_frame
              });
              let logFd = null;
              try {
                logFd = fs9.openSync(logPath, "a");
              } catch {
                logFd = null;
              }
              const stdioConfig = logFd !== null ? ["ignore", logFd, logFd] : "pipe";
              const child = spawnFn(aerenderBin, cliArgs, {
                windowsHide: true,
                detached: true,
                stdio: stdioConfig
              });
              if (logFd !== null) {
                try {
                  fs9.closeSync(logFd);
                } catch {
                }
              }
              if (child.stdout) {
                child.stdout.on("data", (chunk) => {
                  try {
                    fs9.appendFileSync(logPath, chunk);
                  } catch {
                  }
                });
              }
              if (child.stderr) {
                child.stderr.on("data", (chunk) => {
                  try {
                    fs9.appendFileSync(logPath, chunk);
                  } catch {
                  }
                });
              }
              const initialRecord = {
                job_id: jobId,
                pid: typeof child.pid === "number" ? child.pid : null,
                state: "running",
                exit_code: null,
                signal: null,
                cancelled: false,
                project_path: actualProjectPath,
                comp_name: args.comp_name,
                output_path: args.output_path,
                ...args.output_module_template ? { output_module_template: args.output_module_template } : {},
                ...args.render_settings_template ? { render_settings_template: args.render_settings_template } : {},
                ...args.start_frame !== void 0 ? { start_frame: args.start_frame } : {},
                ...args.end_frame !== void 0 ? { end_frame: args.end_frame } : {},
                aerender_path: aerenderBin,
                args: cliArgs,
                log_path: logPath,
                started_at: (/* @__PURE__ */ new Date()).toISOString(),
                finished_at: null
              };
              registry.register(initialRecord, child);
              child.on("error", (err) => {
                try {
                  fs9.appendFileSync(
                    logPath,
                    `
AERENDER SPAWN ERROR: ${err.message}
`
                  );
                } catch {
                }
                const current = registry.get(jobId);
                registry.update(jobId, {
                  state: "failed",
                  exit_code: current?.exit_code ?? -1,
                  error: err.message,
                  finished_at: (/* @__PURE__ */ new Date()).toISOString()
                });
              });
              child.on(
                "exit",
                (code, signal) => {
                  const current = registry.get(jobId);
                  if (current?.cancelled) {
                    registry.update(jobId, {
                      state: "failed",
                      exit_code: code ?? current.exit_code,
                      signal: signal ?? current.signal,
                      finished_at: current.finished_at ?? (/* @__PURE__ */ new Date()).toISOString()
                    });
                    return;
                  }
                  let logError = null;
                  try {
                    const m = /^aerender ERROR:?\s*(.*)$/im.exec(
                      fs9.readFileSync(logPath, "utf8")
                    );
                    if (m) logError = m[1].trim() || "aerender ERROR";
                  } catch {
                    logError = null;
                  }
                  const succeeded = code === 0 && logError === null;
                  registry.update(jobId, {
                    state: succeeded ? "succeeded" : "failed",
                    ...logError ? { error: logError } : {},
                    exit_code: code,
                    signal: signal ?? null,
                    finished_at: (/* @__PURE__ */ new Date()).toISOString()
                  });
                }
              );
              if (typeof child.unref === "function") {
                child.unref();
              }
              return {
                ok: true,
                op_id: opId,
                job_id: jobId,
                pid: initialRecord.pid,
                state: initialRecord.state,
                project_path: initialRecord.project_path,
                comp_name: initialRecord.comp_name,
                output_path: initialRecord.output_path,
                aerender_path: initialRecord.aerender_path,
                args: initialRecord.args,
                log_path: initialRecord.log_path,
                started_at: initialRecord.started_at
              };
            }
          );
        } catch (err) {
          if (err instanceof QueueWaitError) {
            throw new BridgeError({
              kind: "queued",
              op_id: opId,
              message: err.message
            });
          }
          throw err;
        }
      }
    },
    {
      name: "ae_aerender_status",
      description: "Check the status of a background `aerender` job (`running`, `succeeded`, `failed`), parsing `PROGRESS` lines from `<job>.log` for frame progress, exit code, and the log tail. " + AGENT_SAFETY_GUIDANCE,
      schema: AeAerenderStatusSchema,
      handler: async (args) => {
        const registry = getRegistry();
        const job = registry.get(args.job_id);
        if (!job) {
          throw new Error(`No aerender job found with job_id "${args.job_id}".`);
        }
        const { fullText, tail } = readLogTail(job.log_path);
        const progress = parseAerenderProgress(fullText, {
          start_frame: job.start_frame,
          end_frame: job.end_frame,
          state: job.state
        });
        return {
          ok: true,
          job_id: job.job_id,
          pid: job.pid,
          state: job.state,
          exit_code: job.exit_code,
          signal: job.signal,
          cancelled: job.cancelled,
          project_path: job.project_path,
          comp_name: job.comp_name,
          output_path: job.output_path,
          aerender_path: job.aerender_path,
          log_path: job.log_path,
          started_at: job.started_at,
          finished_at: job.finished_at,
          ...job.error ? { error: job.error } : {},
          progress,
          current_frame: progress.current_frame,
          frames_completed: progress.frames_completed,
          total_frames: progress.total_frames,
          percent: progress.percent,
          log_tail: tail
        };
      }
    },
    {
      name: "ae_aerender_cancel",
      description: "Cancel a running background `aerender` job by `job_id`, terminating the process and marking the job as `failed` (`cancelled: true`). " + AGENT_SAFETY_GUIDANCE,
      schema: AeAerenderCancelSchema,
      handler: async (args) => {
        const registry = getRegistry();
        const job = registry.get(args.job_id);
        if (!job) {
          throw new Error(`No aerender job found with job_id "${args.job_id}".`);
        }
        if (job.state !== "running") {
          return {
            ok: true,
            job_id: job.job_id,
            state: job.state,
            exit_code: job.exit_code,
            cancelled: Boolean(job.cancelled),
            already_finished: true
          };
        }
        const proc = registry.getProcess(args.job_id);
        if (proc) {
          try {
            proc.kill("SIGTERM");
          } catch {
          }
        } else if (typeof job.pid === "number" && job.pid > 0) {
          const killFn = options.killProcess ?? ((pid, sig) => process.kill(pid, sig));
          try {
            killFn(job.pid, "SIGTERM");
          } catch {
          }
        }
        try {
          fs9.appendFileSync(
            job.log_path,
            `
AERENDER CANCELLED by ae_aerender_cancel at ${(/* @__PURE__ */ new Date()).toISOString()}
`
          );
        } catch {
        }
        const updated = registry.update(args.job_id, {
          state: "failed",
          cancelled: true,
          finished_at: (/* @__PURE__ */ new Date()).toISOString()
        });
        return {
          ok: true,
          job_id: updated.job_id,
          pid: updated.pid,
          state: updated.state,
          exit_code: updated.exit_code,
          cancelled: true,
          finished_at: updated.finished_at
        };
      }
    }
  ];
}
var aerenderTools = createAerenderTools();

// src/tools/ext/animate.ts
var KeyframeEaseEndSchema = external_exports.object({
  speed: external_exports.number().describe(
    "Temporal ease speed (units per second; typically 0 for smooth ease)."
  ),
  influence: external_exports.number().min(0).max(100).describe(
    "Temporal ease influence percentage (0.1 to 100; values below 0.1 are clamped to 0.1 in After Effects)."
  )
});
var KeyframeEasePairSchema = external_exports.object({
  in: KeyframeEaseEndSchema.describe(
    "Incoming temporal ease {speed, influence}."
  ),
  out: KeyframeEaseEndSchema.describe(
    "Outgoing temporal ease {speed, influence}."
  )
});
var KeyframeEasePresetSchema = external_exports.enum([
  "easy_ease",
  "linear",
  "hold"
]);
var MIN_HANDLE2 = 1e-3;
var EASE_CURVE_ARRAY_SCHEMA = external_exports.array(external_exports.number()).length(4).refine((c) => c[0] >= MIN_HANDLE2 && c[0] <= 1 && c[2] >= 0 && c[2] <= 1 - MIN_HANDLE2, {
  message: `curve x1 must be within ${MIN_HANDLE2}..1 and x2 within 0..${1 - MIN_HANDLE2}`
}).describe(
  "cubic-bezier [x1, y1, x2, y2] as in CSS: x is time and y is progress across one segment, both 0..1. y may leave 0..1 for anticipation or overshoot (not on spatial properties such as Position, whose speed cannot go negative)."
);
var KeyframeEaseCurveSchema = external_exports.object({
  curve: EASE_CURVE_ARRAY_SCHEMA
});
var KeyframeEaseInputSchema = external_exports.union([KeyframeEasePresetSchema, KeyframeEasePairSchema, KeyframeEaseCurveSchema]).describe(
  'A preset ("easy_ease", "linear", or "hold"), an explicit `{ in: { speed, influence }, out: { speed, influence } }` object, or `{ curve: [x1, y1, x2, y2] }`. A curve shapes each segment between neighbouring keys in `keys` (all keys by default): it sets the out ease of the segment\'s first key and the in ease of its last, from that segment\'s duration and distance, and leaves every other side alone.'
);
var AeSetKeyframeEaseSchema = external_exports.object({
  comp_id: external_exports.number().int().describe("Target CompItem ID."),
  layer: LayerSelectorSchema,
  path: external_exports.array(external_exports.union([external_exports.string().min(1), external_exports.number().int().positive()])).min(1).describe(
    "Property path from the layer root (e.g. ['ADBE Transform Group', 'ADBE Position'] or ['Transform', 'Opacity']). A step may be a 1-based positional index instead of a name for a sibling inside an indexed group (effects, masks, shape layer contents), where siblings can share a display name."
  ),
  keys: external_exports.array(external_exports.number().int().positive()).optional().describe(
    "Optional 1-based keyframe indices to update. Defaults to all keyframes on the property."
  ),
  ease: KeyframeEaseInputSchema,
  expect: ExpectSchema
});
function clampInfluenceValue(influence) {
  if (influence < 0.1) return 0.1;
  if (influence > 100) return 100;
  return influence;
}
function extractKeyframeEaseCheck(ease, requestedKeys, afterSnapshot) {
  if (!afterSnapshot || typeof afterSnapshot !== "object" || isCurveEase(ease)) {
    return null;
  }
  const afterObj = afterSnapshot;
  if (!Array.isArray(afterObj.keyframes)) {
    return null;
  }
  const rawKeys = afterObj.keyframes;
  const keySet = requestedKeys && requestedKeys.length > 0 ? new Set(requestedKeys) : null;
  const targeted = keySet ? rawKeys.filter(
    (kf) => typeof kf.keyIndex === "number" && keySet.has(kf.keyIndex)
  ) : rawKeys;
  if (targeted.length === 0) {
    return null;
  }
  if (ease === "hold" || ease === "linear") {
    const expectedInterp = ease;
    return {
      expected: {
        keyframes: targeted.map((kf) => ({
          keyIndex: kf.keyIndex,
          inInterp: expectedInterp,
          outInterp: expectedInterp
        }))
      },
      actual: {
        keyframes: targeted.map((kf) => ({
          keyIndex: kf.keyIndex,
          inInterp: kf.inInterp,
          outInterp: kf.outInterp
        }))
      }
    };
  }
  const targetIn = ease === "easy_ease" ? { speed: 0, influence: 33.333333 } : {
    speed: ease.in.speed,
    influence: clampInfluenceValue(ease.in.influence)
  };
  const targetOut = ease === "easy_ease" ? { speed: 0, influence: 33.333333 } : {
    speed: ease.out.speed,
    influence: clampInfluenceValue(ease.out.influence)
  };
  return {
    expected: {
      keyframes: targeted.map((kf) => {
        const dims = Array.isArray(kf.easeIn) && kf.easeIn.length > 0 ? kf.easeIn.length : 1;
        return {
          keyIndex: kf.keyIndex,
          inInterp: "bezier",
          outInterp: "bezier",
          easeIn: Array.from({ length: dims }, () => ({ ...targetIn })),
          easeOut: Array.from({ length: dims }, () => ({ ...targetOut }))
        };
      })
    },
    actual: {
      keyframes: targeted.map((kf) => ({
        keyIndex: kf.keyIndex,
        inInterp: kf.inInterp,
        outInterp: kf.outInterp,
        easeIn: kf.easeIn,
        easeOut: kf.easeOut
      }))
    }
  };
}
function isCurveEase(ease) {
  return typeof ease === "object" && ease !== null && "curve" in ease;
}
function asVector(v) {
  if (typeof v === "number") return [v];
  if (Array.isArray(v) && v.every((n) => typeof n === "number")) return v;
  return null;
}
function pathLength(from, outTangent, inTangent, to) {
  const dims = Math.min(from.length, to.length);
  const p1 = from.slice(0, dims).map((v, d) => v + (outTangent?.[d] ?? 0));
  const p2 = to.slice(0, dims).map((v, d) => v + (inTangent?.[d] ?? 0));
  const steps = 200;
  let length = 0;
  let prev = from.slice(0, dims);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const point = from.slice(0, dims).map(
      (v, d) => u * u * u * v + 3 * u * u * t * p1[d] + 3 * u * t * t * p2[d] + t * t * t * to[d]
    );
    length += Math.hypot(...point.map((v, d) => v - prev[d]));
    prev = point;
  }
  return length;
}
function curveToSides(snapshot, keys, curve) {
  const snap = snapshot;
  if (!snap || !Array.isArray(snap.keyframes)) {
    throw new Error("Could not read the property's keyframes");
  }
  const byIndex = new Map(snap.keyframes.map((k) => [k.keyIndex, k]));
  const selected = (keys && keys.length > 0 ? [...new Set(keys)] : snap.keyframes.map((k) => k.keyIndex)).sort(
    (a, b) => a - b
  );
  const segments = [];
  for (let i = 0; i + 1 < selected.length; i++) {
    if (selected[i + 1] === selected[i] + 1) segments.push([selected[i], selected[i + 1]]);
  }
  if (segments.length === 0) {
    throw new Error("A curve needs at least two neighbouring keys (for example keys [1, 2]).");
  }
  const x1 = Math.min(1, Math.max(MIN_HANDLE2, curve[0]));
  const x2 = Math.min(1 - MIN_HANDLE2, Math.max(0, curve[2]));
  const y1 = curve[1];
  const y2 = curve[3];
  const warnings = [];
  const sides = /* @__PURE__ */ new Map();
  const sideFor = (key) => {
    let s = sides.get(key);
    if (!s) {
      s = { key };
      sides.set(key, s);
    }
    return s;
  };
  for (const [ai, bi] of segments) {
    const a = byIndex.get(ai);
    const b = byIndex.get(bi);
    if (!a || !b) {
      throw new Error(`Keyframe ${a ? bi : ai} was not read (the property has too many keys)`);
    }
    const duration = b.time - a.time;
    if (!(duration > 0)) throw new Error(`Keys ${ai} and ${bi} share a time`);
    const from = asVector(a.value);
    const to = asVector(b.value);
    if (!from || !to) throw new Error(`Keys ${ai} and ${bi} do not hold numeric values`);
    const dims = Math.max(1, from.length, to.length, a.easeOut?.length ?? 0, b.easeIn?.length ?? 0);
    let distances;
    if (snap.isSpatial) {
      distances = [pathLength(from, asVector(a.outTangent), asVector(b.inTangent), to)];
    } else if (dims === 1) {
      distances = [to[0] - from[0]];
    } else {
      distances = Array.from({ length: dims }, (_, d) => (to[d] ?? 0) - (from[d] ?? 0));
    }
    const speeds = (factor) => distances.map((dist) => {
      const speed = factor * dist / duration;
      if (snap.isSpatial && speed < 0) {
        warnings.push(`Keys ${ai}-${bi}: a spatial speed can't go negative, so the anticipation was dropped.`);
        return 0;
      }
      return speed === 0 ? 0 : speed;
    });
    const outSpeeds = speeds(y1 / x1);
    const inSpeeds = speeds((1 - y2) / (1 - x2));
    sideFor(ai).out = outSpeeds.map((speed) => ({ speed, influence: x1 * 100 }));
    sideFor(bi).in = inSpeeds.map((speed) => ({ speed, influence: (1 - x2) * 100 }));
  }
  return {
    sides: [...sides.values()].sort((p, q) => p.key - q.key),
    segments,
    warnings: [...new Set(warnings)]
  };
}
function easeMatches(expected, actual) {
  if (!actual) return false;
  const speedTol = Math.max(1e-3, Math.abs(expected.speed) * 1e-3);
  return Math.abs(expected.speed - actual.speed) <= speedTol && Math.abs(clampInfluenceValue(expected.influence) - actual.influence) <= 0.01;
}
function curveEaseMismatches(sides, afterSnapshot) {
  const snap = afterSnapshot;
  const mismatches = [];
  const byIndex = new Map((snap?.keyframes ?? []).map((k) => [k.keyIndex, k]));
  for (const side of sides) {
    const kf = byIndex.get(side.key);
    for (const which of ["in", "out"]) {
      const expected = side[which];
      if (!expected) continue;
      const actualList = which === "in" ? kf?.easeIn : kf?.easeOut;
      const interp = which === "in" ? kf?.inInterp : kf?.outInterp;
      const path23 = `keyframes[${side.key}].${which === "in" ? "easeIn" : "easeOut"}`;
      const ok = interp === "bezier" && expected.every((e, d) => easeMatches(e, actualList?.[d]));
      if (!ok) {
        mismatches.push({
          path: path23,
          expected: { interp: "bezier", ease: expected },
          actual: { interp, ease: actualList },
          message: `Expected ${path23} to be bezier ${JSON.stringify(expected)}, got ${interp} ${JSON.stringify(actualList)}`
        });
      }
    }
  }
  return mismatches;
}
var TextJustificationSchema = external_exports.enum(["left", "center", "right"]);
var RgbColorSchema = external_exports.array(external_exports.number().min(0).max(1)).length(3).describe("RGB color array [r, g, b] with components in 0..1.");
var TextStyleSchema = external_exports.object({
  font: external_exports.string().min(1).optional().describe("PostScript font name (e.g. 'Inter-Bold' or 'ArialMT')."),
  fontSize: external_exports.number().positive().optional().describe("Font size in pixels."),
  tracking: external_exports.number().optional().describe("Character tracking value."),
  leading: external_exports.number().optional().describe("Line leading in pixels."),
  fillColor: RgbColorSchema.optional().describe(
    "Fill color [r, g, b] in 0..1."
  ),
  strokeColor: RgbColorSchema.optional().describe(
    "Stroke color [r, g, b] in 0..1."
  ),
  strokeWidth: external_exports.number().min(0).optional().describe("Stroke width in pixels."),
  applyFill: external_exports.boolean().optional().describe("Whether fill is enabled on the text layer."),
  applyStroke: external_exports.boolean().optional().describe("Whether stroke is enabled on the text layer."),
  justification: TextJustificationSchema.optional().describe(
    "Paragraph justification: 'left', 'center', or 'right'."
  )
}).describe("Optional TextDocument styling properties to update.");
function hasAnyStyleField(style) {
  if (!style) return false;
  return style.font !== void 0 || style.fontSize !== void 0 || style.tracking !== void 0 || style.leading !== void 0 || style.fillColor !== void 0 || style.strokeColor !== void 0 || style.strokeWidth !== void 0 || style.applyFill !== void 0 || style.applyStroke !== void 0 || style.justification !== void 0;
}
var AeSetTextSchema = external_exports.object({
  comp_id: external_exports.number().int().describe("Target CompItem ID."),
  layer: LayerSelectorSchema,
  text: external_exports.string().optional().describe("New text string to set on the TextLayer's Source Text."),
  style: TextStyleSchema.optional(),
  expect: ExpectSchema
}).refine((val) => val.text !== void 0 || hasAnyStyleField(val.style), {
  message: "ae_set_text requires at least `text` or one defined property in `style`."
});
var AeImportFootageSchema = external_exports.object({
  paths: external_exports.array(external_exports.string().min(1)).min(1).max(500).describe("Absolute file paths of footage files to import."),
  sequence: external_exports.boolean().optional().describe(
    "If true, import as an image sequence with ImportOptions.forceAlphabetical = true."
  ),
  fps: external_exports.number().positive().optional().describe(
    "Optional frame rate (conformFrameRate) to assign to imported footage items."
  ),
  target_folder_id: external_exports.number().int().optional().describe(
    "Optional FolderItem ID in the project to place the imported items into."
  ),
  expect: ExpectSchema
});
var AeReplaceFootageSchema = external_exports.object({
  item_id: external_exports.number().int().describe("Project FootageItem ID to replace."),
  path: external_exports.string().min(1).describe(
    "Absolute file path to the replacement footage file (or first frame of a sequence)."
  ),
  sequence: external_exports.boolean().optional().describe(
    "If true, use FootageItem.replaceWithSequence(file, true); otherwise use FootageItem.replace(file)."
  ),
  expect: ExpectSchema
});
var animateTools = [
  {
    name: "ae_set_keyframe_ease",
    description: "Set temporal keyframe easing and interpolation on a keyframed layer property within a single undo group, guarded by `expect`, and verified by a separate read-back evalScript receipt. Supports presets ('easy_ease', 'linear', 'hold'), explicit `{ in: { speed, influence }, out: { speed, influence } }` (matched to the property's temporal ease dimension count), or `{ curve: [x1, y1, x2, y2] }`, a CSS-style cubic-bezier applied to each segment between neighbouring keys, such as one the user picked with ae_ask_user. " + AGENT_SAFETY_GUIDANCE,
    schema: AeSetKeyframeEaseSchema,
    handler: async (args, ctx) => {
      ctx.quarantine.assertClear();
      const opId = ctx.bridge.newOpId();
      const label = `ae_set_keyframe_ease(${args.path.join(".")})`;
      const effectiveExpect = {
        project_path: args.expect.project_path,
        comp_id: args.expect.comp_id ?? args.comp_id
      };
      try {
        return await ctx.queue.run(label, async () => {
          ctx.quarantine.assertClear();
          const guard = await verifyTargetGuard(ctx, effectiveExpect, opId);
          const checkpoint = await autoCheckpoint(ctx, guard, "ae_set_keyframe_ease");
          const beforeSnap = await ctx.bridge.evalRaw({
            id: `${opId}_before`,
            script: buildJsxCall("getKeyframeEase", {
              comp_id: args.comp_id,
              layer: args.layer,
              path: args.path
            }),
            label: `${label} (before)`,
            mutates: false,
            toolName: "ae_set_keyframe_ease"
          });
          const curvePlan = isCurveEase(args.ease) ? curveToSides(beforeSnap.result, args.keys, args.ease.curve) : null;
          const writeResp = await ctx.bridge.evalRaw({
            id: opId,
            script: curvePlan ? buildJsxCall("setKeyframeEaseSides", {
              comp_id: args.comp_id,
              layer: args.layer,
              path: args.path,
              sides: curvePlan.sides,
              expect: effectiveExpect
            }) : buildJsxCall("setKeyframeEase", {
              comp_id: args.comp_id,
              layer: args.layer,
              path: args.path,
              keys: args.keys,
              ease: args.ease,
              expect: effectiveExpect
            }),
            label,
            mutates: true,
            toolName: "ae_set_keyframe_ease"
          });
          const afterSnap = await ctx.bridge.evalRaw({
            id: `${opId}_after`,
            script: buildJsxCall("getKeyframeEase", {
              comp_id: args.comp_id,
              layer: args.layer,
              path: args.path
            }),
            label: `${label} (after)`,
            mutates: false,
            toolName: "ae_set_keyframe_ease"
          });
          const easeCheck = extractKeyframeEaseCheck(
            args.ease,
            args.keys,
            afterSnap.result
          );
          const receipt = buildReceipt({
            before: beforeSnap.result,
            after: afterSnap.result,
            expected: easeCheck?.expected,
            actualForExpected: easeCheck?.actual,
            customMismatches: curvePlan ? curveEaseMismatches(curvePlan.sides, afterSnap.result) : void 0
          });
          return {
            op_id: opId,
            applied: true,
            result: writeResp.result,
            ...curvePlan ? {
              curve: args.ease,
              segments: curvePlan.segments,
              ...curvePlan.warnings.length > 0 ? { warnings: curvePlan.warnings } : {}
            } : {},
            checkpoint,
            receipt
          };
        });
      } catch (err) {
        if (err instanceof QueueWaitError) {
          throw new BridgeError({
            kind: "queued",
            op_id: opId,
            message: err.message
          });
        }
        throw err;
      }
    }
  },
  {
    name: "ae_set_text",
    description: "Update a text layer's string and/or character/paragraph styling (`font`, `fontSize`, `tracking`, `leading`, `fillColor`, `strokeColor`, `strokeWidth`, `applyFill`, `applyStroke`, `justification`) via a guarded TextDocument round-trip in one undo group, re-asserting justification if AE's TextDocument round-trip drops it, and verifying via a separate read-back evalScript. " + AGENT_SAFETY_GUIDANCE,
    schema: AeSetTextSchema,
    handler: async (args, ctx) => {
      ctx.quarantine.assertClear();
      const opId = ctx.bridge.newOpId();
      const label = `ae_set_text(comp ${args.comp_id})`;
      const effectiveExpect = {
        project_path: args.expect.project_path,
        comp_id: args.expect.comp_id ?? args.comp_id
      };
      try {
        return await ctx.queue.run(label, async () => {
          ctx.quarantine.assertClear();
          const guard = await verifyTargetGuard(ctx, effectiveExpect, opId);
          const checkpoint = await autoCheckpoint(ctx, guard, "ae_set_text");
          const beforeSnap = await ctx.bridge.evalRaw({
            id: `${opId}_before`,
            script: buildJsxCall("getTextDocument", {
              comp_id: args.comp_id,
              layer: args.layer
            }),
            label: `${label} (before)`,
            mutates: false,
            toolName: "ae_set_text"
          });
          const writeResp = await ctx.bridge.evalRaw({
            id: opId,
            script: buildJsxCall("setText", {
              comp_id: args.comp_id,
              layer: args.layer,
              text: args.text,
              style: args.style,
              expect: effectiveExpect
            }),
            label,
            mutates: true,
            toolName: "ae_set_text"
          });
          const afterSnap = await ctx.bridge.evalRaw({
            id: `${opId}_after`,
            script: buildJsxCall("getTextDocument", {
              comp_id: args.comp_id,
              layer: args.layer
            }),
            label: `${label} (after)`,
            mutates: false,
            toolName: "ae_set_text"
          });
          const beforeObj = beforeSnap.result ?? {};
          const beforeDoc = beforeObj.document && typeof beforeObj.document === "object" ? beforeObj.document : beforeObj;
          const afterObj = afterSnap.result ?? {};
          const afterDoc = afterObj.document && typeof afterObj.document === "object" ? afterObj.document : afterObj;
          const expectedCheck = {};
          const actualCheck = {};
          if (args.text !== void 0) {
            expectedCheck.text = args.text;
            actualCheck.text = afterDoc.text;
          }
          if (args.style) {
            const styleKeys = [
              "font",
              "fontSize",
              "tracking",
              "leading",
              "fillColor",
              "strokeColor",
              "strokeWidth",
              "applyFill",
              "applyStroke",
              "justification"
            ];
            for (const key of styleKeys) {
              if (args.style[key] !== void 0) {
                expectedCheck[key] = args.style[key];
                actualCheck[key] = afterDoc[key];
              }
            }
          }
          if (expectedCheck.justification === void 0 && typeof beforeDoc.justification === "string" && typeof afterDoc.justification === "string") {
            expectedCheck.justification = beforeDoc.justification;
            actualCheck.justification = afterDoc.justification;
          }
          const receipt = buildReceipt({
            before: beforeSnap.result,
            after: afterSnap.result,
            expected: Object.keys(expectedCheck).length > 0 ? expectedCheck : void 0,
            actualForExpected: Object.keys(expectedCheck).length > 0 ? actualCheck : void 0
          });
          return {
            op_id: opId,
            applied: true,
            result: writeResp.result,
            checkpoint,
            receipt
          };
        });
      } catch (err) {
        if (err instanceof QueueWaitError) {
          throw new BridgeError({
            kind: "queued",
            op_id: opId,
            message: err.message
          });
        }
        throw err;
      }
    }
  },
  {
    name: "ae_import_footage",
    description: "Import one or more footage files (or an image sequence with `ImportOptions.forceAlphabetical = true`) into the project and optional target folder, guarded by `expect`, within one undo group, returning the new project `item_ids` and a separate read-back receipt. " + AGENT_SAFETY_GUIDANCE,
    schema: AeImportFootageSchema,
    handler: async (args, ctx) => {
      ctx.quarantine.assertClear();
      const opId = ctx.bridge.newOpId();
      const label = `ae_import_footage(${args.paths.length} file${args.paths.length === 1 ? "" : "s"})`;
      try {
        return await ctx.queue.run(label, async () => {
          ctx.quarantine.assertClear();
          const guard = await verifyTargetGuard(ctx, args.expect, opId);
          const checkpoint = await autoCheckpoint(ctx, guard, "ae_import_footage");
          const beforeSnap = await ctx.bridge.evalRaw({
            id: `${opId}_before`,
            script: buildJsxCall("getFootageItems", {}),
            label: `${label} (before)`,
            mutates: false,
            toolName: "ae_import_footage"
          });
          const writeResp = await ctx.bridge.evalRaw({
            id: opId,
            script: buildJsxCall("importFootage", {
              paths: args.paths,
              sequence: Boolean(args.sequence),
              fps: args.fps,
              target_folder_id: args.target_folder_id,
              expect: args.expect
            }),
            label,
            timeoutMs: SLOW_TIMEOUT_MS,
            mutates: true,
            toolName: "ae_import_footage"
          });
          const itemIds = Array.isArray(writeResp.result?.item_ids) ? writeResp.result.item_ids : [];
          const afterSnap = await ctx.bridge.evalRaw({
            id: `${opId}_after`,
            script: buildJsxCall("getFootageItems", {
              item_ids: itemIds
            }),
            label: `${label} (after)`,
            mutates: false,
            toolName: "ae_import_footage"
          });
          const afterIds = Array.isArray(afterSnap.result?.item_ids) ? afterSnap.result.item_ids : [];
          const receipt = buildReceipt({
            before: beforeSnap.result,
            after: afterSnap.result,
            expected: {
              count: args.paths.length,
              item_ids: itemIds
            },
            actualForExpected: {
              count: afterIds.length,
              item_ids: afterIds
            }
          });
          return {
            op_id: opId,
            applied: true,
            item_ids: itemIds,
            items: Array.isArray(writeResp.result?.items) ? writeResp.result.items : [],
            result: writeResp.result,
            checkpoint,
            receipt
          };
        });
      } catch (err) {
        if (err instanceof QueueWaitError) {
          throw new BridgeError({
            kind: "queued",
            op_id: opId,
            message: err.message
          });
        }
        throw err;
      }
    }
  },
  {
    name: "ae_replace_footage",
    description: "Replace or relink an existing FootageItem using `FootageItem.replace` or `FootageItem.replaceWithSequence` within one undo group, guarded by `expect`, returning the before and after file paths, `footageMissing`, and a separate read-back receipt. " + AGENT_SAFETY_GUIDANCE,
    schema: AeReplaceFootageSchema,
    handler: async (args, ctx) => {
      ctx.quarantine.assertClear();
      const opId = ctx.bridge.newOpId();
      const label = `ae_replace_footage(${args.item_id})`;
      try {
        return await ctx.queue.run(label, async () => {
          ctx.quarantine.assertClear();
          const guard = await verifyTargetGuard(ctx, args.expect, opId);
          const checkpoint = await autoCheckpoint(ctx, guard, "ae_replace_footage");
          const beforeSnap = await ctx.bridge.evalRaw({
            id: `${opId}_before`,
            script: buildJsxCall("getFootageItem", {
              item_id: args.item_id
            }),
            label: `${label} (before)`,
            mutates: false,
            toolName: "ae_replace_footage"
          });
          const writeResp = await ctx.bridge.evalRaw({
            id: opId,
            script: buildJsxCall("replaceFootage", {
              item_id: args.item_id,
              path: args.path,
              sequence: Boolean(args.sequence),
              expect: args.expect
            }),
            label,
            timeoutMs: SLOW_TIMEOUT_MS,
            mutates: true,
            toolName: "ae_replace_footage"
          });
          const afterSnap = await ctx.bridge.evalRaw({
            id: `${opId}_after`,
            script: buildJsxCall("getFootageItem", {
              item_id: args.item_id
            }),
            label: `${label} (after)`,
            mutates: false,
            toolName: "ae_replace_footage"
          });
          const beforeObj = beforeSnap.result ?? {};
          const writeObj = writeResp.result ?? {};
          const afterObj = afterSnap.result ?? {};
          const beforeFile = typeof beforeObj.file === "string" ? beforeObj.file : typeof writeObj.before_file === "string" ? writeObj.before_file : null;
          const beforeMissing = typeof beforeObj.footageMissing === "boolean" ? beforeObj.footageMissing : typeof writeObj.before_footage_missing === "boolean" ? writeObj.before_footage_missing : false;
          const afterFile = typeof afterObj.file === "string" ? afterObj.file : typeof writeObj.requested_path === "string" ? writeObj.requested_path : null;
          const afterMissing = typeof afterObj.footageMissing === "boolean" ? afterObj.footageMissing : false;
          const receipt = buildReceipt({
            before: beforeSnap.result,
            after: afterSnap.result,
            expected: {
              file: normalizeGuardPath(args.path),
              footageMissing: false
            },
            actualForExpected: {
              file: typeof afterFile === "string" ? normalizeGuardPath(afterFile) : null,
              footageMissing: afterMissing
            }
          });
          return {
            op_id: opId,
            applied: true,
            item_id: args.item_id,
            before_path: beforeFile,
            after_path: afterFile,
            before_file: beforeFile,
            after_file: afterFile,
            before_footage_missing: beforeMissing,
            footageMissing: afterMissing,
            result: writeResp.result,
            checkpoint,
            receipt
          };
        });
      } catch (err) {
        if (err instanceof QueueWaitError) {
          throw new BridgeError({
            kind: "queued",
            op_id: opId,
            message: err.message
          });
        }
        throw err;
      }
    }
  }
];

// src/tools/ext/ask.ts
var fs10 = __toESM(require("node:fs"), 1);
var path11 = __toESM(require("node:path"), 1);
var PANEL_EXTENSION_ID = "london.chroma.aemcp.panel";
var DEFAULT_WAIT_SECONDS = 120;
var MAX_IMAGE_BYTES = 8 * 1024 * 1024;
var AskOptionSchema = external_exports.object({
  id: external_exports.string().min(1).max(40).describe("Short id returned when the user picks this option."),
  label: external_exports.string().min(1).max(120),
  description: external_exports.string().max(400).optional(),
  curve: EASE_CURVE_ARRAY_SCHEMA.optional().describe(
    "cubic-bezier [x1, y1, x2, y2] (CSS convention). Required on every option of an ease question."
  ),
  image_path: external_exports.string().min(1).optional().describe(
    "Absolute path of a PNG or JPEG shown with the option, such as an ae_contact_sheet or ae_snapshot_frame of that variant."
  )
});
var AeAskUserSchema = external_exports.object({
  ask_id: external_exports.string().min(1).optional().describe("Keep waiting for a question asked earlier (its ask_id) instead of asking a new one."),
  question: external_exports.string().min(1).max(500).optional(),
  kind: external_exports.enum(["choice", "ease"]).optional().describe(
    "'choice' (default) shows buttons. 'ease' draws each option's curve with a moving preview and lets the user drag the handles; the answer then carries the final curve."
  ),
  options: external_exports.array(AskOptionSchema).min(2).max(8).optional(),
  multi_select: external_exports.boolean().optional().describe("Allow several options. Default false."),
  allow_other: external_exports.boolean().optional().describe("Let the user type their own answer. Default true."),
  context: external_exports.string().max(300).optional().describe("One line under the question, such as which layer and keys it is about."),
  wait_seconds: external_exports.number().int().min(0).max(600).optional().describe(
    `How long to wait for the answer (default ${DEFAULT_WAIT_SECONDS}). If it runs out, the result is status 'waiting' with the ask_id; the question stays in the panel.`
  )
}).refine((v) => v.ask_id !== void 0 || v.question !== void 0 && v.options !== void 0, {
  message: "Give a question and options, or the ask_id of an earlier question."
}).refine((v) => v.kind !== "ease" || (v.options ?? []).every((o) => o.curve !== void 0), {
  message: "Every option of an ease question needs a curve."
}).refine((v) => new Set((v.options ?? []).map((o) => o.id)).size === (v.options ?? []).length, {
  message: "Option ids must be unique."
});
function checkImagePath(p) {
  if (!path11.isAbsolute(p)) return `image_path must be absolute: ${p}`;
  if (!/\.(png|jpe?g)$/i.test(p)) return `image_path must be a PNG or JPEG: ${p}`;
  try {
    const st = fs10.statSync(p);
    if (!st.isFile()) return `image_path is not a file: ${p}`;
    if (st.size > MAX_IMAGE_BYTES) return `image_path is over 8 MB: ${p}`;
  } catch {
    return `image_path does not exist: ${p}`;
  }
  return null;
}
function presentAnswer(q, a) {
  if (!a) {
    return {
      status: "waiting",
      ask_id: q.id,
      question: q.question,
      message: "No answer yet; the question stays in the panel. Call ae_ask_user with this ask_id to keep waiting, or carry on and check back later."
    };
  }
  if (a.status === "dismissed") {
    return {
      status: "dismissed",
      ask_id: q.id,
      question: q.question,
      message: "The user dismissed the question. Don't ask it again unprompted; go on with a sensible default and say which."
    };
  }
  const byId = new Map(q.options.map((o) => [o.id, o]));
  return {
    status: "answered",
    ask_id: q.id,
    question: q.question,
    chosen: a.choice_ids.map((id) => ({ id, label: byId.get(id)?.label ?? id })),
    ...a.other ? { other: a.other } : {},
    ...a.curve ? {
      curve: a.curve,
      edited: !a.choice_ids.some((id) => sameCurve(byId.get(id)?.curve, a.curve)),
      next: "Apply it with ae_set_keyframe_ease { ease: { curve } }. Ask whether it should become the user's default; if so, save it with ae_taste."
    } : {},
    answered_after_s: Math.round((a.answered_at - q.asked_at) / 100) / 10
  };
}
function sameCurve(a, b) {
  return !!a && !!b && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-3);
}
var askTools = [
  {
    name: "ae_ask_user",
    description: "Ask the user a question in the Chroma AE MCP panel inside After Effects and wait for the answer. Opens the panel if it is closed. Use it when a choice is the user's to make (a look, a timing, which variant), and show rather than describe: give each option an image (an ae_contact_sheet of that variant) or, with kind 'ease', a curve. For eases, offer 3 or 4 distinct curves (for example gentle [0.25,0.1,0.25,1], snappy [0.2,0,0,1], expo out [0.16,1,0.3,1], anticipate [0.6,-0.28,0.74,0.05] on non-spatial properties); the user can also drag the handles, and the answer's curve goes straight into ae_set_keyframe_ease. Ask one thing at a time. Results: 'answered' (chosen options, free text, curve), 'dismissed', or 'waiting' (call again with ask_id). Never touches the project.",
    schema: AeAskUserSchema,
    handler: async (args, ctx) => {
      const asks = ctx.asks;
      if (!asks) {
        return {
          ok: false,
          error: "panel_unavailable",
          message: "ae_ask_user needs the MCP that runs inside the After Effects panel; ask in the chat instead."
        };
      }
      const waitMs = (args.wait_seconds ?? DEFAULT_WAIT_SECONDS) * 1e3;
      if (args.ask_id) {
        const found = asks.get(args.ask_id);
        if (!found) {
          return {
            ok: false,
            error: "unknown_ask_id",
            message: "No such question. Answered questions are kept for an hour, and restarting AE clears them."
          };
        }
        const answer2 = found.answer ?? await asks.wait(args.ask_id, waitMs);
        return presentAnswer(found.question, answer2);
      }
      for (const o of args.options) {
        if (o.image_path) {
          const problem = checkImagePath(o.image_path);
          if (problem) return { ok: false, error: "bad_image", message: problem };
        }
      }
      const question = asks.ask({
        question: args.question,
        kind: args.kind ?? "choice",
        options: args.options,
        multi_select: args.multi_select ?? false,
        allow_other: args.allow_other ?? true,
        ...args.context ? { context: args.context } : {}
      });
      if (ctx.cep) {
        try {
          await ctx.cep.openExtension(PANEL_EXTENSION_ID);
        } catch {
        }
      }
      const answer = await asks.wait(question.id, waitMs);
      return presentAnswer(question, answer);
    }
  }
];

// src/tools/ext/brief.ts
var fs11 = __toESM(require("node:fs"), 1);
var path12 = __toESM(require("node:path"), 1);
var BriefFieldsSchema = external_exports.object({
  goal: external_exports.string().max(1e3).optional().describe("What the piece is for and the one thing it must get across."),
  audience: external_exports.string().max(500).optional().describe("Who watches it, and where (platform, screen)."),
  format: external_exports.object({
    width: external_exports.number().int().positive().optional(),
    height: external_exports.number().int().positive().optional(),
    fps: external_exports.number().positive().optional(),
    duration_s: external_exports.number().positive().optional()
  }).optional().describe("Delivery size, frame rate and length."),
  feel: external_exports.array(external_exports.string().min(1).max(40)).max(6).optional().describe("A few words for the feel, e.g. ['confident', 'clean', 'snappy']."),
  references: external_exports.array(external_exports.string().min(1).max(500)).max(20).optional().describe("Links, file paths, or descriptions of work to match."),
  brand_colors: external_exports.array(external_exports.string().regex(/^#[0-9a-fA-F]{6}$/, "colors are #rrggbb")).max(12).optional().describe("Brand colours as #rrggbb."),
  fonts: external_exports.array(external_exports.string().min(1).max(100)).max(6).optional(),
  do_not_change: external_exports.array(external_exports.string().min(1).max(300)).max(20).optional().describe("Layers, comps or decisions to leave alone."),
  notes: external_exports.string().max(4e3).optional()
});
var AeBriefSchema = external_exports.object({
  set: BriefFieldsSchema.optional().describe(
    "Fields to save. Omitted fields keep their value; an empty string or list clears one. Save only what the user said or confirmed."
  ),
  expect: external_exports.object({ project_path: external_exports.string().min(1) }).optional().describe("Required with `set`: the open project's path, so the brief lands next to the right .aep.")
}).refine((v) => !v.set || v.expect !== void 0, { message: "Saving a brief needs expect.project_path." });
var BRIEF_FIELDS = ["goal", "audience", "format", "feel", "references", "brand_colors", "fonts", "do_not_change"];
var BRIEF_QUESTIONS = {
  goal: { question: "What is this piece for, and what is the one thing it must get across?" },
  audience: {
    question: "Who will watch it, and where?",
    options: [
      { id: "social_vertical", label: "Social, vertical (Reels, TikTok, Shorts)" },
      { id: "web_16x9", label: "YouTube or web, 16:9" },
      { id: "broadcast", label: "Broadcast or TV" },
      { id: "event", label: "Event screen or presentation" }
    ]
  },
  format: { question: "What size, frame rate and length should it be delivered at?" },
  feel: {
    question: "Which words fit the feel?",
    options: [
      { id: "calm", label: "Calm" },
      { id: "energetic", label: "Energetic" },
      { id: "playful", label: "Playful" },
      { id: "premium", label: "Premium" },
      { id: "technical", label: "Technical" },
      { id: "bold", label: "Bold" }
    ],
    multi_select: true
  },
  references: { question: "Is there any work (links or files) it should feel like?" },
  brand_colors: { question: "Which brand colours should it use (hex codes)?" },
  fonts: { question: "Which fonts should it use?" },
  do_not_change: { question: "Is there anything I must leave alone?" }
};
function briefPath(projectPath) {
  return path12.join(path12.dirname(projectPath), `${path12.basename(projectPath, path12.extname(projectPath))}.brief.json`);
}
function isEmpty(v) {
  if (v === void 0 || v === null || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v).length === 0;
  return false;
}
function readBrief(file) {
  try {
    const parsed = JSON.parse(fs11.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}
function mergeBrief(current, patch, now) {
  const next = { ...current ?? {} };
  for (const [k, v] of Object.entries(patch)) {
    if (v === void 0) continue;
    if (isEmpty(v)) delete next[k];
    else next[k] = v;
  }
  next.updated_at = now.toISOString();
  return next;
}
function missingFields(brief) {
  return BRIEF_FIELDS.filter((f) => isEmpty(brief?.[f]));
}
async function openProjectPath(ctx) {
  const res = await ctx.bridge.evalRaw({
    id: `${ctx.bridge.newOpId()}_brief_status`,
    script: buildJsxCall("status", {}),
    label: "ae_brief (project path)",
    mutates: false,
    toolName: "ae_brief"
  });
  return res.result.project_path;
}
var AeTasteSchema = external_exports.object({
  set: external_exports.object({
    // Deliberately not EASE_CURVE_ARRAY_SCHEMA/MIN_HANDLE-bounded: [0, 0, 1, 1] (x1=0,
    // x2=1) is a meaningful "clear to linear" sentinel here, checked by isLinear() below
    // before it's ever applied as a curve - the tighter apply-time bound would reject it.
    preferred_ease: external_exports.array(external_exports.number()).length(4).refine((c) => c[0] >= 0 && c[0] <= 1 && c[2] >= 0 && c[2] <= 1, { message: "curve x1 and x2 must be within 0..1" }).optional().describe("The user's default cubic-bezier [x1, y1, x2, y2], e.g. the one they picked with ae_ask_user. [0, 0, 1, 1] (linear) clears it."),
    allow_linear_non_motion: external_exports.boolean().optional().describe("Linear timing on opacity and effect parameters is on purpose: the review stops flagging it."),
    avoid_overshoot: external_exports.boolean().optional().describe("The user doesn't want overshoot: the review reports it as low instead of info."),
    notes: external_exports.string().max(2e3).optional().describe("What the user has said about their taste, in their words. Replaces the earlier notes.")
  }).optional().describe("Fields to change. Save only what the user said or confirmed.")
});
function isLinear(c) {
  return c[0] === 0 && c[1] === 0 && c[2] === 1 && c[3] === 1;
}
var briefTools = [
  {
    name: "ae_brief",
    description: "Read or save the open project's brief: goal, audience, format, feel, references, brand colours and fonts, and what not to change. It lives next to the .aep as <name>.brief.json, so it travels with the project. Call it at the start of any creative job. The result lists `missing` fields with `questions`; ask the ones that matter for the task, choices through ae_ask_user (pass the question and options as given) and open questions in the chat, then save the answers with `set`. Respect `do_not_change` in everything you do. Unsaved projects have no brief until they are saved. Never touches the AE project.",
    schema: AeBriefSchema,
    handler: async (args, ctx) => {
      const projectPath = await openProjectPath(ctx);
      if (projectPath === "<unsaved>") {
        return {
          ok: false,
          error: "unsaved_project",
          message: "The project has not been saved, so there is nowhere to keep a brief yet. Ask the user to save it (or keep the brief in the chat for now)."
        };
      }
      const file = briefPath(projectPath);
      let brief = readBrief(file);
      let saved = false;
      if (args.set) {
        if (normalizeGuardPath(args.expect.project_path) !== normalizeGuardPath(projectPath)) {
          return {
            ok: false,
            error: "guard",
            message: `The open project is ${projectPath}, not ${args.expect.project_path}. Re-read state; nothing was saved.`
          };
        }
        brief = mergeBrief(brief, args.set, /* @__PURE__ */ new Date());
        const tmp = `${file}.tmp-${process.pid}`;
        fs11.writeFileSync(tmp, JSON.stringify(brief, null, 2), { encoding: "utf8", mode: 384 });
        fs11.renameSync(tmp, file);
        saved = true;
      }
      const missing = missingFields(brief);
      return {
        ok: true,
        project_path: projectPath,
        brief_path: file,
        exists: brief !== null,
        saved,
        brief,
        missing,
        questions: missing.map((field) => ({ field, ...BRIEF_QUESTIONS[field] }))
      };
    }
  },
  {
    name: "ae_taste",
    description: "Read or change the user's motion taste, kept across projects: a preferred ease curve, whether linear opacity and effect timing is deliberate, whether overshoot is unwanted, and notes in their words. ae_motion_review follows it (its fixes use the preferred curve's handle lengths). Read it before animating so first passes already match. Change it only on the user's word: after they pick an ease with ae_ask_user, ask whether it should become their default. Call with no arguments to read.",
    schema: AeTasteSchema,
    handler: async (args, ctx) => {
      if (!ctx.settings) {
        return { ok: false, error: "no_settings", message: "This server has no settings store, so taste can't be kept." };
      }
      let saved = false;
      if (args.set) {
        const patch = { ...args.set };
        if (patch.preferred_ease && isLinear(patch.preferred_ease)) {
          patch.preferred_ease = null;
        }
        ctx.settings.updateTaste(patch);
        saved = true;
      }
      return { ok: true, saved, taste: ctx.settings.get().taste, settings_path: ctx.settings.path };
    }
  }
];

// src/tools/ext/data.ts
var fs12 = __toESM(require("node:fs"), 1);
var path13 = __toESM(require("node:path"), 1);
function parseCsv(text) {
  const src = text.replace(/^﻿/, "");
  const records = [];
  let field = "";
  let record = [];
  let quoted = false;
  let quotedInRecord = false;
  let i = 0;
  const endField = () => {
    record.push(field);
    field = "";
  };
  const endRecord = () => {
    endField();
    if (!(record.length === 1 && record[0] === "" && !quotedInRecord)) records.push(record);
    record = [];
    quotedInRecord = false;
  };
  while (i < src.length) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === "") {
      quoted = true;
      quotedInRecord = true;
    } else if (c === ",") {
      endField();
    } else if (c === "\n" || c === "\r") {
      endRecord();
      if (c === "\r" && src[i + 1] === "\n") i++;
    } else {
      field += c;
    }
    i++;
  }
  if (quoted) throw new Error("CSV ends inside a quoted field");
  if (field !== "" || record.length > 0) endRecord();
  if (records.length === 0) return [];
  const header = records[0].map((h) => h.trim());
  return records.slice(1).map((r) => {
    const row = {};
    header.forEach((h, idx) => {
      row[h] = r[idx] ?? "";
    });
    return row;
  });
}
function parseDataFile(filePath) {
  const text = fs12.readFileSync(filePath, "utf8");
  if (/\.csv$/i.test(filePath)) return parseCsv(text);
  const parsed = JSON.parse(text.replace(/^﻿/, ""));
  const rows = Array.isArray(parsed) ? parsed : parsed?.rows;
  if (!Array.isArray(rows) || !rows.every((r) => r && typeof r === "object" && !Array.isArray(r))) {
    throw new Error("JSON data must be an array of objects, or { rows: [...] }");
  }
  return rows;
}
function isBlank(v) {
  return v === null || v === void 0 || typeof v === "string" && v.trim() === "";
}
function toNumber(s) {
  const t = s.trim();
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?%?$/i.test(t)) return void 0;
  return Number(t.replace(/%$/, ""));
}
function cellValue(target, cell) {
  if (target === "text") return { value: String(cell) };
  if (target === "footage") {
    const p = String(cell).trim();
    if (!path13.isAbsolute(p)) return { error: `"${p}" is not an absolute path` };
    if (!fs12.existsSync(p)) return { error: `file not found: ${p}` };
    return { value: p.replace(/\\/g, "/") };
  }
  if (target === "color") {
    if (Array.isArray(cell) && cell.length >= 3 && cell.every((n2) => typeof n2 === "number")) {
      return { value: cell.length === 3 ? [...cell, 1] : cell.slice(0, 4) };
    }
    const m = /^#?([0-9a-f]{6})$/i.exec(String(cell).trim());
    if (!m) return { error: `"${String(cell)}" is not a #rrggbb colour` };
    const n = parseInt(m[1], 16);
    return { value: [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255, 1] };
  }
  if (typeof cell === "number") return { value: cell };
  if (typeof cell === "boolean") return { value: cell ? 1 : 0 };
  if (Array.isArray(cell) && cell.every((n) => typeof n === "number")) return { value: cell };
  const s = String(cell).trim().replace(/^\[|\]$/g, "");
  if (/^(true|false)$/i.test(s)) return { value: /^true$/i.test(s) ? 1 : 0 };
  const parts = s.split(/[,;]\s*|\s+/).filter((x) => x !== "");
  const nums = parts.map(toNumber);
  if (nums.length === 0 || nums.some((n) => n === void 0)) return { error: `"${String(cell)}" is not a number or a list of numbers` };
  return { value: nums.length === 1 ? nums[0] : nums };
}
function fillName(pattern, row, rowNumber, templateName) {
  const name = pattern.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, key) => {
    if (key === "#") return String(rowNumber);
    if (key === "template") return templateName;
    const v = row[key];
    return v === void 0 || v === null ? "" : String(v);
  }).trim();
  return name === "" ? `${templateName} - ${rowNumber}` : name;
}
var DataMappingSchema = external_exports.object({
  column: external_exports.string().min(1).describe("Column (CSV header or JSON key) the value comes from."),
  layer: LayerSelectorSchema.describe("Layer in the template comp (by name is usual; names must be unique)."),
  target: external_exports.enum(["text", "value", "color", "footage"]).describe(
    'text: the layer\'s Source Text (style kept; every text key if keyed). value: a number or list ("100, 50") on `path`. color: #rrggbb on `path`. footage: an absolute file path, imported once and swapped in with replaceSource.'
  ),
  path: external_exports.array(external_exports.string().min(1)).optional().describe("For value and color: property path by match name or name, e.g. ['ADBE Effect Parade', 'Bar Height', 'ADBE Slider Control-0001'] or ['ADBE Transform Group', 'ADBE Scale']."),
  keyframe: external_exports.union([external_exports.enum(["last", "first", "all"]), external_exports.number().int().positive()]).optional().describe("For animated properties: which key takes the value. Default 'last' (a bar that grows to the data value).")
}).refine((m) => m.target === "text" || m.target === "footage" || m.path !== void 0 && m.path.length > 0, {
  message: "value and color mappings need a path"
});
var AeBuildFromDataSchema = external_exports.object({
  template_comp_id: external_exports.number().int().describe("The comp to copy for each row."),
  rows: external_exports.array(external_exports.record(external_exports.union([external_exports.string(), external_exports.number(), external_exports.boolean(), external_exports.null()]))).max(200).optional().describe("The data, one object per row."),
  data_path: external_exports.string().min(1).optional().describe("Or an absolute path to a .csv (header row first) or .json (array of objects) file."),
  mapping: external_exports.array(DataMappingSchema).min(1).max(50),
  name: external_exports.string().min(1).max(200).optional().describe("Name pattern for each copy: {{column}}, {{#}} (row number), {{template}}. Default '{{template}} - {{#}}'."),
  folder: external_exports.string().min(1).max(200).optional().describe("Project folder for the copies (and imported footage). Default '<template> (data)'."),
  in_place: external_exports.boolean().optional().describe("Set the template comp itself from a single row instead of copying it, e.g. to update a chart."),
  dry_run: external_exports.boolean().optional().describe("Check the data and mapping against the template and report what would be built, without writing."),
  expect: ExpectSchema
}).refine((v) => v.rows === void 0 !== (v.data_path === void 0), { message: "Give either rows or data_path." });
function prepareRows(rows, mapping, namePattern, templateName) {
  const problems = [];
  const skipped = [];
  const columns = new Set(rows.flatMap((r) => Object.keys(r)));
  for (const m of mapping) {
    if (rows.length > 0 && !columns.has(m.column)) problems.push(`column "${m.column}" is not in the data (columns: ${[...columns].join(", ")})`);
  }
  const prepared = rows.map((r, i) => {
    const values = mapping.map((m) => {
      const cell = r[m.column];
      if (isBlank(cell)) {
        if (columns.has(m.column)) skipped.push(`row ${i + 1}: "${m.column}" is empty, so the template's value stays`);
        return null;
      }
      const v = cellValue(m.target, cell);
      if ("error" in v) {
        problems.push(`row ${i + 1}, "${m.column}": ${v.error}`);
        return null;
      }
      return v.value;
    });
    return { row: i + 1, name: fillName(namePattern, r, i + 1, templateName), values };
  });
  return { prepared, problems, skipped };
}
function normText(s) {
  return s.replace(/\r\n?/g, "\n");
}
function checkBuild(prepared, mapping, read) {
  const mismatches = [];
  const offFrame = [];
  read.forEach((c, ci) => {
    const row = prepared[ci];
    mapping.forEach((m, mi) => {
      const expected = row?.values[mi];
      const got = c.values[mi] ?? {};
      const where = `${c.name}.${m.column}`;
      if (expected === null || expected === void 0) return;
      if (m.target === "text") {
        if (got.bounds) {
          const b = got.bounds;
          if (b.left < -0.5 || b.top < -0.5 || b.right > c.width + 0.5 || b.bottom > c.height + 0.5) {
            offFrame.push({ comp: c.name, layer: m.column, bounds: b });
          }
        }
        if (normText(String(got.text ?? "")) !== normText(String(expected))) {
          mismatches.push({ path: where, expected, actual: got.text, message: `Text of ${where} reads back differently` });
        }
      } else if (m.target === "footage") {
        const foldCase = process.platform === "win32";
        const a = String(got.footage ?? "").replace(/\\/g, "/");
        const b = String(expected).replace(/\\/g, "/");
        const same = foldCase ? a.toLowerCase() === b.toLowerCase() : a === b;
        if (!same) {
          mismatches.push({ path: where, expected, actual: got.footage, message: `Footage of ${where} reads back differently` });
        }
      } else {
        const values = got.key_values && got.key_values.length > 0 ? got.key_values : [got.value];
        values.forEach((gv, ki) => {
          const actual = Array.isArray(expected) && Array.isArray(gv) && gv.length > expected.length ? gv.slice(0, expected.length) : gv;
          const label = values.length > 1 ? `${where}[key ${got.keys?.[ki] ?? ki + 1}]` : where;
          compareValues(expected, actual, label, mismatches);
        });
      }
    });
  });
  return { mismatches, off_frame: offFrame };
}
function validateAgainstTemplate(rows, prepared, mapping, inspected) {
  const problems = [];
  mapping.forEach((m, mi) => {
    const insp = inspected[mi];
    if (!insp) return;
    const label = `mapping ${mi + 1} ("${m.column}")`;
    if (insp.error) {
      problems.push(`${label}: ${insp.error}`);
      return;
    }
    if (!prepared.some((p) => p.values[mi] !== null && p.values[mi] !== void 0)) return;
    if (m.target === "footage") {
      if (!insp.can_take_footage) problems.push(`${label}: layer "${m.layer.name ?? m.layer.index ?? m.layer.id}" can't take footage (it needs a footage, solid or precomp layer)`);
      return;
    }
    if (m.target === "text") return;
    const where = (m.path ?? []).join(" > ");
    const dims = insp.dims ?? 0;
    if (m.target === "color" && !insp.is_color) {
      problems.push(`${label}: ${where} is not a colour property`);
      return;
    }
    if (dims === 0) {
      problems.push(`${label}: ${where} doesn't take numbers`);
      return;
    }
    if (typeof m.keyframe === "number" && (insp.num_keys ?? 0) > 0 && m.keyframe > (insp.num_keys ?? 0)) {
      problems.push(`${label}: keyframe ${m.keyframe} is past the last of ${insp.num_keys} keys on ${where}`);
    }
    if (m.target === "color") return;
    prepared.forEach((p) => {
      const v = p.values[mi];
      if (v === null || v === void 0) return;
      const raw = String(rows[p.row - 1]?.[m.column]);
      const at = `row ${p.row}, "${m.column}"`;
      if (Array.isArray(v)) {
        if (dims === 1) {
          problems.push(`${at}: "${raw}" reads as a list of ${v.length} numbers; for a decimal use a point, 1.5`);
        } else if (v.length !== dims && !(dims === 3 && v.length === 2)) {
          problems.push(`${at}: "${raw}" has ${v.length} numbers, but ${where} takes ${dims}`);
        }
      } else if (dims > 1) {
        problems.push(`${at}: "${raw}" is a single number, but ${where} takes ${dims} (e.g. "100, 75")`);
      }
    });
  });
  return problems;
}
async function inspectMapping(ctx, compId, mapping) {
  const res = await ctx.bridge.evalRaw({
    id: `${ctx.bridge.newOpId()}_data_inspect`,
    script: buildJsxCall("inspectDataMapping", { template_comp_id: compId, mapping }),
    label: "ae_build_from_data (inspect mapping)",
    mutates: false,
    toolName: "ae_build_from_data"
  });
  return res.result?.mappings ?? [];
}
async function templateInfo(ctx, compId) {
  const res = await ctx.bridge.evalRaw({
    id: `${ctx.bridge.newOpId()}_data_template`,
    script: buildJsxCall("getComp", { comp_id: compId }),
    label: "ae_build_from_data (template)",
    mutates: false,
    toolName: "ae_build_from_data"
  });
  return res.result;
}
var dataTools = [
  {
    name: "ae_build_from_data",
    description: "Build comps from data (CSV or JSON): one copy of a template comp per row, named from the row, with text, numbers, colours and footage set from its columns. For localisation (a row per language), versions of a lower third or end card, and charts whose bars, sliders or labels are driven by numbers. `in_place` sets the template itself from one row (to update a chart). Animated properties get the value on their last key by default (a bar that grows to the number); `keyframe` picks another. Empty cells keep the template's value. Every cell is checked before AE is touched (bad numbers, colours, missing files are refused with the row); `dry_run` reports the plan without writing. The build is one undo group guarded by `expect`, with an auto checkpoint; the values are read back in a separate evalScript, and text that now runs off the frame is listed in `off_frame`. Up to 200 rows a call. " + AGENT_SAFETY_GUIDANCE,
    schema: AeBuildFromDataSchema,
    handler: async (args, ctx) => {
      let rows;
      if (args.data_path) {
        if (!path13.isAbsolute(args.data_path) || !fs12.existsSync(args.data_path)) {
          return { ok: false, error: "bad_data", message: `Not an existing absolute path: ${args.data_path}` };
        }
        try {
          rows = parseDataFile(args.data_path);
        } catch (err) {
          return { ok: false, error: "bad_data", message: err instanceof Error ? err.message : String(err) };
        }
        if (rows.length > 200) {
          return { ok: false, error: "too_many_rows", message: `${rows.length} rows; build up to 200 a call (split the file).` };
        }
      } else {
        rows = args.rows;
      }
      if (rows.length === 0) return { ok: false, error: "bad_data", message: "The data has no rows." };
      if (args.in_place && rows.length !== 1) {
        return { ok: false, error: "bad_args", message: "in_place sets the template from exactly one row." };
      }
      const template = await templateInfo(ctx, args.template_comp_id);
      const templateName = template?.name ?? `comp ${args.template_comp_id}`;
      const { prepared, problems, skipped } = prepareRows(rows, args.mapping, args.name ?? "{{template}} - {{#}}", templateName);
      const mapping = args.mapping.map((m) => ({ layer: m.layer, target: m.target, path: m.path, keyframe: m.keyframe }));
      const inspected = await inspectMapping(ctx, args.template_comp_id, mapping);
      problems.push(...validateAgainstTemplate(rows, prepared, args.mapping, inspected));
      if (problems.length > 0) {
        return { ok: false, error: "bad_data", message: "Some cells can't be used; nothing was built.", problems };
      }
      const folder = args.in_place ? void 0 : args.folder ?? `${templateName} (data)`;
      if (args.dry_run) {
        return {
          ok: true,
          dry_run: true,
          template: templateName,
          folder,
          comps: prepared.map((p) => ({ row: p.row, name: args.in_place ? templateName : p.name, values: p.values })),
          skipped
        };
      }
      ctx.quarantine.assertClear();
      const expect = { project_path: args.expect.project_path, comp_id: args.expect.comp_id ?? args.template_comp_id };
      const opId = ctx.bridge.newOpId();
      const projectSnapshot = (suffix) => ctx.bridge.evalRaw({
        id: `${opId}_${suffix}`,
        script: buildJsxCall("snapshotForReceipt", {}),
        label: `ae_build_from_data (${suffix} snapshot)`,
        mutates: false,
        toolName: "ae_build_from_data"
      });
      try {
        return await ctx.queue.run("ae_build_from_data", async () => {
          ctx.quarantine.assertClear();
          const guard = await verifyTargetGuard(ctx, expect, opId);
          const checkpoint = await autoCheckpoint(ctx, guard, "ae_build_from_data");
          const before = await projectSnapshot("before");
          const write = await ctx.bridge.evalRaw({
            id: opId,
            script: buildJsxCall("buildFromData", {
              expect,
              template_comp_id: args.template_comp_id,
              mapping,
              rows: prepared.map((p) => ({ row: p.row, name: p.name, values: p.values })),
              folder_name: folder,
              in_place: args.in_place === true
            }),
            label: `ae_build_from_data(${prepared.length})`,
            mutates: true,
            toolName: "ae_build_from_data"
          });
          const built = write.result;
          const after = await projectSnapshot("after");
          const read = await ctx.bridge.evalRaw({
            id: `${opId}_read`,
            script: buildJsxCall("readDataBuild", { comp_ids: built.comps.map((c) => c.comp_id), mapping: built.mapping }),
            label: "ae_build_from_data (read back)",
            mutates: false,
            toolName: "ae_build_from_data"
          });
          const { mismatches, off_frame } = checkBuild(prepared, args.mapping, read.result.comps);
          return {
            ok: true,
            op_id: opId,
            applied: true,
            folder_id: built.folder_id,
            comps: built.comps,
            skipped,
            off_frame,
            checkpoint,
            receipt: buildReceipt({ before: before.result, after: after.result, customMismatches: mismatches })
          };
        });
      } catch (err) {
        if (err instanceof QueueWaitError) {
          throw new BridgeError({ kind: "queued", op_id: opId, message: err.message });
        }
        throw err;
      }
    }
  }
];

// src/tools/ext/effects.ts
var fs13 = __toESM(require("node:fs"), 1);
var path14 = __toESM(require("node:path"), 1);
var EffectSelectorSchema = external_exports.object({
  index: external_exports.number().int().positive().optional().describe("1-based position in the layer's Effects."),
  name: external_exports.string().min(1).optional().describe("Effect name as shown on the layer (refused if several share it).")
}).refine((v) => v.index !== void 0 || v.name !== void 0, {
  message: "Effect selector needs index or name."
}).describe("Which effect on the layer, by index or name.");
var EffectParamSchema = external_exports.object({
  param: external_exports.union([external_exports.string().min(1), external_exports.number().int().positive()]).describe("Parameter display name (e.g. 'Blurriness'), match name, or 1-based index."),
  value: external_exports.union([external_exports.number(), external_exports.boolean(), external_exports.array(external_exports.number())]).describe(
    "Number, boolean (checkboxes), or array (points, colors as [r, g, b] or [r, g, b, a] in 0..1). Popups take their 1-based item number; layer pickers take a layer index (0 for none)."
  )
});
var ParamsSchema = external_exports.array(EffectParamSchema).max(100).optional().describe(
  "Static values to set. An animated parameter gets the value at the comp's current time; for keyframes or expressions use ae_set_property with the path ['ADBE Effect Parade', <effect name>, <param>]."
);
var AeAddEffectSchema = external_exports.object({
  comp_id: external_exports.number().int(),
  layer: LayerSelectorSchema,
  effect: external_exports.string().min(1).describe("Match name (e.g. 'ADBE Gaussian Blur 2', 'APC Colorama') or display name. Look it up with ae_list_effects."),
  name: external_exports.string().min(1).max(200).optional().describe("Rename the new effect."),
  params: ParamsSchema,
  expect: ExpectSchema
});
var AeSetEffectSchema = external_exports.object({
  comp_id: external_exports.number().int(),
  layer: LayerSelectorSchema,
  effect: EffectSelectorSchema,
  enabled: external_exports.boolean().optional().describe("Turn the effect on or off (the fx switch)."),
  name: external_exports.string().min(1).max(200).optional().describe("Rename the effect."),
  params: ParamsSchema,
  expect: ExpectSchema
}).refine((v) => v.enabled !== void 0 || v.name !== void 0 || (v.params?.length ?? 0) > 0, {
  message: "Give at least one of enabled, name, or params."
});
var AeRemoveEffectSchema = external_exports.object({
  comp_id: external_exports.number().int(),
  layer: LayerSelectorSchema,
  effect: EffectSelectorSchema,
  expect: ExpectSchema
});
var AeApplyPresetSchema = external_exports.object({
  comp_id: external_exports.number().int(),
  layer: LayerSelectorSchema,
  preset_path: external_exports.string().min(1).describe("Absolute path of the .ffx animation preset (see ae_list_presets)."),
  expect: ExpectSchema
});
var AeListPresetsSchema = external_exports.object({
  filter: external_exports.string().optional().describe("Case-insensitive text to match in the preset's folder and file name, e.g. 'glow' or 'Transitions - Wipes'."),
  source: external_exports.enum(["all", "user", "app"]).optional().describe("'user' is the user's own User Presets folders. Default all."),
  limit: external_exports.number().int().min(1).max(500).optional().describe("Default 100.")
});
function findParamSnapshot(effect, key) {
  if (!effect) return void 0;
  if (typeof key === "number") return effect.params.find((p) => p.path.length === 1 && p.index === key);
  return effect.params.find((p) => p.name === key || p.matchName === key);
}
function expectedParamValue(type, value) {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (type === "color" && Array.isArray(value) && value.length === 3) return [...value, 1];
  return value;
}
function paramMismatches(effect, params, written) {
  const mismatches = [];
  (params ?? []).forEach((p, i) => {
    if (written?.[i]?.how === "value_at_current_time") return;
    const snap = findParamSnapshot(effect, p.param);
    if (!snap) {
      mismatches.push({ path: `params.${p.param}`, expected: p.value, actual: void 0, message: `Parameter ${p.param} not found in read-back` });
      return;
    }
    compareValues(expectedParamValue(snap.type, p.value), snap.value, `params.${snap.name}`, mismatches);
  });
  return mismatches;
}
function effectAt(snapshot, index) {
  const effects = snapshot?.effects ?? [];
  return effects.find((e) => e.index === index);
}
function effectCount(snapshot) {
  return (snapshot?.effects ?? []).length;
}
async function runEffectWrite(args, ctx, spec) {
  ctx.quarantine.assertClear();
  const opId = ctx.bridge.newOpId();
  const effectiveExpect = {
    project_path: args.expect.project_path,
    comp_id: args.expect.comp_id ?? args.comp_id
  };
  const readEffects = (suffix) => ctx.bridge.evalRaw({
    id: `${opId}_${suffix}`,
    script: buildJsxCall("listLayerEffects", { comp_id: args.comp_id, layer: args.layer }),
    label: `${spec.label} (${suffix})`,
    mutates: false,
    toolName: spec.toolName
  });
  try {
    return await ctx.queue.run(spec.label, async () => {
      ctx.quarantine.assertClear();
      const guard = await verifyTargetGuard(ctx, effectiveExpect, opId);
      const checkpoint = await autoCheckpoint(ctx, guard, spec.toolName);
      const before = await readEffects("before");
      const write = await ctx.bridge.evalRaw({
        id: opId,
        script: buildJsxCall(spec.host, spec.hostArgs(args, effectiveExpect)),
        label: spec.label,
        mutates: true,
        toolName: spec.toolName
      });
      const after = await readEffects("after");
      const written = write.result ?? {};
      const receipt = buildReceipt({
        before: before.result,
        after: after.result,
        customMismatches: spec.check(args, before.result, after.result, written)
      });
      return {
        op_id: opId,
        applied: true,
        ...spec.present(args, before.result, after.result, written),
        checkpoint,
        receipt
      };
    });
  } catch (err) {
    if (err instanceof QueueWaitError) {
      throw new BridgeError({ kind: "queued", op_id: opId, message: err.message });
    }
    throw err;
  }
}
var MAX_PRESET_FILES = 2e4;
var MAX_PRESET_DEPTH = 8;
var PRESET_CACHE_TTL_MS = 5e3;
var presetCache = null;
function walkPresetsUnfiltered(folders, source) {
  const all = [];
  let scanned = 0;
  for (const folder of folders) {
    const kind = folder.kind === "user" ? "user" : "app";
    if (source !== "all" && source !== kind) continue;
    const walk = (dir, depth) => {
      if (depth > MAX_PRESET_DEPTH || scanned >= MAX_PRESET_FILES) return;
      let entries;
      try {
        entries = fs13.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path14.join(dir, e.name);
        if (e.isDirectory()) {
          walk(full, depth + 1);
        } else if (/\.ffx$/i.test(e.name)) {
          scanned++;
          const rawCategory = path14.relative(folder.path, dir).split(path14.sep).join("/");
          const name = e.name.replace(/\.ffx$/i, "");
          all.push({
            name,
            path: full,
            category: rawCategory || path14.basename(folder.path),
            matchKey: `${rawCategory}/${name}`.toLowerCase(),
            source: kind
          });
        }
      }
    };
    walk(folder.path, 0);
  }
  return { all, scanned };
}
function findPresets(folders, filter, source) {
  const key = source + "|" + folders.map((f) => `${f.kind}:${f.path}`).join("|");
  const now = Date.now();
  let cached;
  if (presetCache && presetCache.key === key && now - presetCache.at < PRESET_CACHE_TTL_MS) {
    cached = presetCache;
  } else {
    cached = walkPresetsUnfiltered(folders, source);
    presetCache = { key, at: now, ...cached };
  }
  const needle = filter?.trim().toLowerCase() ?? "";
  const matched = needle ? cached.all.filter((p) => p.matchKey.includes(needle)) : cached.all.slice();
  matched.sort((a, b) => a.source === b.source ? a.path.localeCompare(b.path) : a.source === "user" ? -1 : 1);
  const presets = matched.map(({ matchKey, ...rest }) => rest);
  return { presets, scanned: cached.scanned };
}
var PRESET_HINT = `Parameters marked settable: false (custom data such as Colorama's Output Cycle or the Curves curve) can't be read or set by script; AE refuses it. Measured routes, all inside AE: (1) link it by expression to the same parameter of an effect the user set up by hand (ae_set_property on the path ['ADBE Effect Parade', <effect name>, <param matchName>], since a section header can share the param's display name, with an expression such as thisComp.layer("Look").effect("Colorama")("Output Cycle"); \`linkable_by_expression\` says when this works); (2) apply an animation preset saved from AE (Animation > Save Animation Preset) with ae_apply_preset; (3) the effect's own preset menu, if any (Colorama's 'Use Preset Palette' is an ordinary settable popup).`;
var effectsTools = [
  {
    name: "ae_add_effect",
    description: "Add an effect to a layer, optionally renamed and with static parameter values, in one undo group guarded by `expect`. Returns the effect's index and every parameter (name, match name, type, value, settable), read back in a separate evalScript. Find the effect's match name with ae_list_effects; display names vary by AE language. " + PRESET_HINT + " " + AGENT_SAFETY_GUIDANCE,
    schema: AeAddEffectSchema,
    handler: (args, ctx) => runEffectWrite(args, ctx, {
      toolName: "ae_add_effect",
      label: `ae_add_effect(${args.effect})`,
      host: "addEffect",
      hostArgs: (a, expect) => ({ comp_id: a.comp_id, layer: a.layer, effect: a.effect, name: a.name, params: a.params, expect }),
      check: (a, before, after, w) => {
        const mismatches = [];
        if (effectCount(after) !== effectCount(before) + 1) {
          mismatches.push({ path: "effects.length", expected: effectCount(before) + 1, actual: effectCount(after), message: "Effect count did not grow by one" });
        }
        const fx = effectAt(after, w.index);
        compareValues(w.matchName, fx?.matchName, "effect.matchName", mismatches);
        if (a.name) compareValues(a.name, fx?.name, "effect.name", mismatches);
        return [...mismatches, ...paramMismatches(fx, a.params, w.params_set)];
      },
      present: (_a, _before, after, w) => ({ effect: effectAt(after, w.index) ?? w })
    })
  },
  {
    name: "ae_set_effect",
    description: "Change an effect on a layer: turn it on or off, rename it, or set static parameter values, in one undo group guarded by `expect`, with a read-back in a separate evalScript. For keyframes or expressions on a parameter, use ae_set_property with the path ['ADBE Effect Parade', <effect name>, <param>]. " + PRESET_HINT + " " + AGENT_SAFETY_GUIDANCE,
    schema: AeSetEffectSchema,
    handler: (args, ctx) => runEffectWrite(args, ctx, {
      toolName: "ae_set_effect",
      label: `ae_set_effect(${args.effect.name ?? `#${args.effect.index}`})`,
      host: "setEffect",
      hostArgs: (a, expect) => ({ comp_id: a.comp_id, layer: a.layer, effect: a.effect, enabled: a.enabled, name: a.name, params: a.params, expect }),
      check: (a, _before, after, w) => {
        const mismatches = [];
        const fx = effectAt(after, w.index);
        if (a.enabled !== void 0) compareValues(a.enabled, fx?.enabled, "effect.enabled", mismatches);
        if (a.name) compareValues(a.name, fx?.name, "effect.name", mismatches);
        return [...mismatches, ...paramMismatches(fx, a.params, w.params_set)];
      },
      present: (_a, _before, after, w) => ({ effect: effectAt(after, w.index) ?? w })
    })
  },
  {
    name: "ae_remove_effect",
    description: "Remove one effect from a layer, in one undo group guarded by `expect` (Edit > Undo brings it back). The read-back confirms the layer has one effect fewer. " + AGENT_SAFETY_GUIDANCE,
    schema: AeRemoveEffectSchema,
    handler: (args, ctx) => runEffectWrite(args, ctx, {
      toolName: "ae_remove_effect",
      label: `ae_remove_effect(${args.effect.name ?? `#${args.effect.index}`})`,
      host: "removeEffect",
      hostArgs: (a, expect) => ({ comp_id: a.comp_id, layer: a.layer, effect: a.effect, expect }),
      check: (_a, before, after) => effectCount(after) === effectCount(before) - 1 ? [] : [{ path: "effects.length", expected: effectCount(before) - 1, actual: effectCount(after), message: "Effect count did not drop by one" }],
      present: (_a, _before, after, w) => ({
        removed: w.removed,
        remaining: (after?.effects ?? []).map((e) => ({ index: e.index, name: e.name, matchName: e.matchName }))
      })
    })
  },
  {
    name: "ae_apply_preset",
    description: "Apply an animation preset (.ffx) to one layer, as Animation > Apply Animation Preset does, in one undo group guarded by `expect`. AE applies presets to the selected layers, so the target is selected alone for the call and the user's selection is restored. Presets can add effects, keyframes and expressions; the result lists the effects added (read back in a separate evalScript). This is how custom-data parameters such as Colorama's Output Cycle get in. Find presets with ae_list_presets. " + AGENT_SAFETY_GUIDANCE,
    schema: AeApplyPresetSchema,
    handler: async (args, ctx) => {
      if (!path14.isAbsolute(args.preset_path) || !/\.ffx$/i.test(args.preset_path) || !fs13.existsSync(args.preset_path)) {
        return { ok: false, error: "bad_preset", message: `Not an existing absolute .ffx path: ${args.preset_path}` };
      }
      return runEffectWrite(args, ctx, {
        toolName: "ae_apply_preset",
        label: `ae_apply_preset(${path14.basename(args.preset_path)})`,
        host: "applyPreset",
        hostArgs: (a, expect) => ({ comp_id: a.comp_id, layer: a.layer, preset_path: a.preset_path.replace(/\\/g, "/"), expect }),
        check: (_a, before, after) => effectCount(after) >= effectCount(before) ? [] : [{ path: "effects.length", expected: `>= ${effectCount(before)}`, actual: effectCount(after), message: "Applying the preset removed effects" }],
        present: (_a, before, after, w) => ({
          preset: w.preset,
          effects_added: (after?.effects ?? []).slice(effectCount(before)).map((e) => ({ index: e.index, name: e.name, matchName: e.matchName })),
          layers_added: w.layers_added
        })
      });
    }
  },
  {
    name: "ae_list_presets",
    description: "List animation presets (.ffx) in the user's User Presets folders (every installed AE version, listed first) and AE's own Presets folder, with a text filter. Use the path with ae_apply_preset. Read-only.",
    schema: AeListPresetsSchema,
    handler: async (args, ctx) => {
      const res = await ctx.bridge.evalRaw({
        id: `${ctx.bridge.newOpId()}_presets`,
        script: buildJsxCall("presetFolders", {}),
        label: "ae_list_presets (folders)",
        mutates: false,
        toolName: "ae_list_presets"
      });
      const folders = res.result?.folders ?? [];
      const { presets, scanned } = findPresets(folders, args.filter, args.source ?? "all");
      const limit = args.limit ?? 100;
      return {
        folders,
        scanned,
        count: presets.length,
        truncated: presets.length > limit,
        presets: presets.slice(0, limit)
      };
    }
  }
];

// src/tools/ext/explore.ts
var LAYER_INCLUDE_SECTIONS = [
  "transform",
  "effects",
  "masks",
  "text",
  "shapes",
  "expressions",
  "keyframes",
  "markers"
];
var LayerIncludeSectionSchema = external_exports.enum(LAYER_INCLUDE_SECTIONS);
var AeGetLayerFullSchema = external_exports.object({
  comp_id: external_exports.number().int().describe("The CompItem ID containing the target layer."),
  layer: LayerSelectorSchema,
  include: external_exports.array(LayerIncludeSectionSchema).optional().describe(
    "Optional subset of sections to include (defaults to all: transform, effects, masks, text, shapes, expressions, keyframes, markers)."
  ),
  max_keyframes: external_exports.number().int().min(1).max(500).default(100).describe(
    "Maximum number of keyframes to return per animated property (default: 100, max: 500)."
  ),
  shape_depth: external_exports.number().int().min(1).max(12).default(4).describe(
    "Maximum recursion depth into shape layer vector groups (default: 4, max: 12)."
  )
});
var AeFindLayersSchema = external_exports.object({
  comp_id: external_exports.number().int().optional().describe(
    "Optional CompItem ID to search within. If omitted, searches across all compositions in the project."
  ),
  name_contains: external_exports.string().min(1).optional().describe("Case-insensitive substring match against layer name."),
  type: external_exports.string().min(1).optional().describe(
    "Layer type filter (e.g. 'text', 'shape', 'camera', 'light', 'null', 'adjustment', 'precomp', 'solid', 'av', 'audio', or AE class names like 'TextLayer', 'ShapeLayer', 'AVLayer')."
  ),
  has_effect_match_name: external_exports.string().min(1).optional().describe(
    "Match layers that have an applied effect matching this matchName (or display name), case-insensitively."
  ),
  has_expression: external_exports.boolean().optional().describe(
    "If true, only layers with at least one expression; if false, only layers with no expressions."
  ),
  source_id: external_exports.number().int().optional().describe("Match layers whose source item has this project item ID."),
  limit: external_exports.number().int().min(1).max(500).default(200).describe("Maximum number of matching layers to return (default: 200, max: 500).")
});
var AeListEffectsSchema = external_exports.object({
  filter: external_exports.string().optional().describe(
    "Optional case-insensitive substring filter matched against displayName, matchName, or category."
  )
});
var AeValidateExpressionsSchema = external_exports.object({
  comp_id: external_exports.number().int().describe("The CompItem ID whose layer expressions should be validated."),
  layer: LayerSelectorSchema.optional().describe(
    "Optional layer selector to restrict validation to a single layer (defaults to all layers in the comp)."
  ),
  time: external_exports.number().optional().describe(
    "Optional evaluation time in seconds passed to prop.valueAtTime(t, false) (defaults to comp.time without changing comp.time)."
  )
});
var exploreTools = [
  {
    name: "ae_get_layer_full",
    description: "Read everything about a layer in one bounded call: layer metadata plus optional sections (transform, effects, masks, text, shapes, expressions, keyframes, markers). Read-only: never modifies project or composition state. " + AGENT_SAFETY_GUIDANCE,
    schema: AeGetLayerFullSchema,
    handler: async (args, ctx) => {
      const max_keyframes = args.max_keyframes ?? 100;
      const shape_depth = args.shape_depth ?? 4;
      const res = await ctx.bridge.callHost(
        "getLayerFull",
        {
          comp_id: args.comp_id,
          layer: args.layer,
          include: args.include,
          max_keyframes,
          shape_depth
        },
        {
          label: `ae_get_layer_full(${args.comp_id})`,
          mutates: false,
          toolName: "ae_get_layer_full"
        }
      );
      return res.result;
    }
  },
  {
    name: "ae_find_layers",
    description: "Search one composition or all compositions in the project for layers matching filters (name_contains, type, has_effect_match_name, has_expression, source_id), up to `limit` (default 200). Read-only: never modifies project or composition state. " + AGENT_SAFETY_GUIDANCE,
    schema: AeFindLayersSchema,
    handler: async (args, ctx) => {
      const limit = args.limit ?? 200;
      const res = await ctx.bridge.callHost(
        "findLayers",
        {
          comp_id: args.comp_id,
          name_contains: args.name_contains,
          type: args.type,
          has_effect_match_name: args.has_effect_match_name,
          has_expression: args.has_expression,
          source_id: args.source_id,
          limit
        },
        {
          label: args.comp_id !== void 0 ? `ae_find_layers(${args.comp_id})` : "ae_find_layers(all)",
          mutates: false,
          toolName: "ae_find_layers"
        }
      );
      return res.result;
    }
  },
  {
    name: "ae_list_effects",
    description: "List installed After Effects effects from `app.effects` (displayName, matchName, category, version), optionally filtered by substring and bounded to 500 entries. Read-only: never modifies project or composition state. " + AGENT_SAFETY_GUIDANCE,
    schema: AeListEffectsSchema,
    handler: async (args, ctx) => {
      const res = await ctx.bridge.callHost(
        "listEffects",
        {
          filter: args.filter
        },
        {
          label: args.filter ? `ae_list_effects(${args.filter})` : "ae_list_effects",
          mutates: false,
          toolName: "ae_list_effects"
        }
      );
      return res.result;
    }
  },
  {
    name: "ae_validate_expressions",
    description: "Walk all properties with expressions in a composition (or a single layer), force evaluation via `prop.valueAtTime(t, false)` inside try/catch, and read `prop.expressionError` without ever toggling `expressionEnabled` or mutating `comp.time`. Returns `results: [{layer, path, expression, expressionEnabled, error}]` along with counts. " + AGENT_SAFETY_GUIDANCE,
    schema: AeValidateExpressionsSchema,
    handler: async (args, ctx) => {
      const res = await ctx.bridge.callHost(
        "validateExpressions",
        {
          comp_id: args.comp_id,
          layer: args.layer,
          time: args.time
        },
        {
          label: `ae_validate_expressions(${args.comp_id})`,
          mutates: false,
          toolName: "ae_validate_expressions"
        }
      );
      return res.result;
    }
  }
];

// src/tools/ext/frames.ts
var crypto3 = __toESM(require("node:crypto"), 1);
var fs16 = __toESM(require("node:fs"), 1);
var path16 = __toESM(require("node:path"), 1);
var import_pngjs2 = __toESM(require_png(), 1);

// src/tools/render.ts
var crypto2 = __toESM(require("node:crypto"), 1);
var fs15 = __toESM(require("node:fs"), 1);
var path15 = __toESM(require("node:path"), 1);

// src/tools/ext/png-utils.ts
var fs14 = __toESM(require("node:fs"), 1);
var import_pngjs = __toESM(require_png(), 1);
function fitWithin(width, height, maxSize) {
  const longEdge = Math.max(width, height);
  if (longEdge <= maxSize) return { width, height };
  const k = maxSize / longEdge;
  return {
    width: Math.max(1, Math.round(width * k)),
    height: Math.max(1, Math.round(height * k))
  };
}
function areaSpans(srcLen, dstLen) {
  const ratio = srcLen / dstLen;
  const spans = [];
  for (let d = 0; d < dstLen; d++) {
    const s0 = d * ratio;
    const s1 = Math.min(srcLen, (d + 1) * ratio);
    const start = Math.floor(s0);
    const end = Math.min(srcLen, Math.ceil(s1));
    const weights = [];
    for (let s = start; s < end; s++) {
      weights.push(Math.min(s + 1, s1) - Math.max(s, s0));
    }
    spans.push({ start, weights, norm: s1 - s0 });
  }
  return spans;
}
function resizeArea(src, dstWidth, dstHeight) {
  const sw = src.width;
  const sh = src.height;
  const dw = Math.max(1, Math.min(sw, Math.round(dstWidth)));
  const dh = Math.max(1, Math.min(sh, Math.round(dstHeight)));
  const out = new import_pngjs.PNG({ width: dw, height: dh });
  if (dw === sw && dh === sh) {
    Buffer.from(src.data.buffer, src.data.byteOffset, sw * sh * 4).copy(out.data);
    return out;
  }
  const xSpans = areaSpans(sw, dw);
  const tmp = new Float32Array(dw * sh * 4);
  const data = src.data;
  for (let y = 0; y < sh; y++) {
    const rowIn = y * sw * 4;
    const rowOut = y * dw * 4;
    for (let dx = 0; dx < dw; dx++) {
      const span = xSpans[dx];
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let k = 0; k < span.weights.length; k++) {
        const i = rowIn + (span.start + k) * 4;
        const w = span.weights[k];
        const alpha = data[i + 3] / 255;
        r += data[i] * alpha * w;
        g += data[i + 1] * alpha * w;
        b += data[i + 2] * alpha * w;
        a += alpha * w;
      }
      const o = rowOut + dx * 4;
      tmp[o] = r / span.norm;
      tmp[o + 1] = g / span.norm;
      tmp[o + 2] = b / span.norm;
      tmp[o + 3] = a / span.norm;
    }
  }
  const ySpans = areaSpans(sh, dh);
  for (let dy = 0; dy < dh; dy++) {
    const span = ySpans[dy];
    for (let dx = 0; dx < dw; dx++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let k = 0; k < span.weights.length; k++) {
        const i = ((span.start + k) * dw + dx) * 4;
        const w = span.weights[k];
        r += tmp[i] * w;
        g += tmp[i + 1] * w;
        b += tmp[i + 2] * w;
        a += tmp[i + 3] * w;
      }
      r /= span.norm;
      g /= span.norm;
      b /= span.norm;
      a /= span.norm;
      const o = (dy * dw + dx) * 4;
      if (a > 0) {
        out.data[o] = clamp255(r / a);
        out.data[o + 1] = clamp255(g / a);
        out.data[o + 2] = clamp255(b / a);
      }
      out.data[o + 3] = clamp255(a * 255);
    }
  }
  return out;
}
function clamp255(v) {
  return v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v);
}
function flattenOnChecker(src, cell = 8, light = 204, dark = 153) {
  const { width, height, data } = src;
  const out = new import_pngjs.PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const bg = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0 ? light : dark;
      const a = data[i + 3] / 255;
      out.data[i] = Math.round(data[i] * a + bg * (1 - a));
      out.data[i + 1] = Math.round(data[i + 1] * a + bg * (1 - a));
      out.data[i + 2] = Math.round(data[i + 2] * a + bg * (1 - a));
      out.data[i + 3] = 255;
    }
  }
  return out;
}
function createCanvas(width, height, fill) {
  const out = new import_pngjs.PNG({ width, height });
  for (let i = 0; i < width * height * 4; i += 4) {
    out.data[i] = fill[0];
    out.data[i + 1] = fill[1];
    out.data[i + 2] = fill[2];
    out.data[i + 3] = fill[3];
  }
  return out;
}
function blit(dst, src, x, y) {
  for (let sy = 0; sy < src.height; sy++) {
    const dy = y + sy;
    if (dy < 0 || dy >= dst.height) continue;
    for (let sx = 0; sx < src.width; sx++) {
      const dx = x + sx;
      if (dx < 0 || dx >= dst.width) continue;
      const si = (sy * src.width + sx) * 4;
      const di = (dy * dst.width + dx) * 4;
      dst.data[di] = src.data[si];
      dst.data[di + 1] = src.data[si + 1];
      dst.data[di + 2] = src.data[si + 2];
      dst.data[di + 3] = src.data[si + 3];
    }
  }
}
function fillRect(dst, x, y, w, h, rgba) {
  const a = rgba[3] / 255;
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(dst.width, x + w);
  const y1 = Math.min(dst.height, y + h);
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      const i = (py * dst.width + px) * 4;
      dst.data[i] = Math.round(rgba[0] * a + dst.data[i] * (1 - a));
      dst.data[i + 1] = Math.round(rgba[1] * a + dst.data[i + 1] * (1 - a));
      dst.data[i + 2] = Math.round(rgba[2] * a + dst.data[i + 2] * (1 - a));
      dst.data[i + 3] = Math.max(dst.data[i + 3], rgba[3]);
    }
  }
}
function strokeRect(dst, x, y, w, h, thickness, rgba) {
  fillRect(dst, x, y, w, thickness, rgba);
  fillRect(dst, x, y + h - thickness, w, thickness, rgba);
  fillRect(dst, x, y, thickness, h, rgba);
  fillRect(dst, x + w - thickness, y, thickness, h, rgba);
}
function drawLine(dst, x0, y0, x1, y1, thickness, rgba) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  const off = Math.floor(thickness / 2);
  for (let i = 0; i <= steps; i++) {
    const x = Math.round(x0 + (x1 - x0) * i / steps);
    const y = Math.round(y0 + (y1 - y0) * i / steps);
    fillRect(dst, x - off, y - off, thickness, thickness, rgba);
  }
}
var GLYPHS = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  ":": ["00000", "01100", "01100", "00000", "01100", "01100", "00000"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  "#": ["01010", "01010", "11111", "01010", "11111", "01010", "01010"],
  s: ["00000", "00000", "01110", "10000", "01110", "00001", "11110"],
  f: ["00110", "01001", "01000", "11100", "01000", "01000", "01000"]
};
var GLYPH_WIDTH = 5;
var GLYPH_HEIGHT = 7;
var GLYPH_ADVANCE = GLYPH_WIDTH + 1;
function textWidth(text, scale) {
  return text.length === 0 ? 0 : (text.length * GLYPH_ADVANCE - 1) * scale;
}
function drawText(dst, text, x, y, scale, rgba) {
  for (let ci = 0; ci < text.length; ci++) {
    const glyph = GLYPHS[text[ci]];
    if (!glyph) continue;
    for (let row = 0; row < GLYPH_HEIGHT; row++) {
      for (let col = 0; col < GLYPH_WIDTH; col++) {
        if (glyph[row][col] === "1") {
          fillRect(dst, x + (ci * GLYPH_ADVANCE + col) * scale, y + row * scale, scale, scale, rgba);
        }
      }
    }
  }
}
function encodePng(img) {
  return import_pngjs.PNG.sync.write(img);
}
function writeScaledCopy(srcPath, dstPath, opts) {
  const src = import_pngjs.PNG.sync.read(fs14.readFileSync(srcPath));
  let target = { width: src.width, height: src.height };
  if (opts.maxSize !== void 0) {
    target = fitWithin(src.width, src.height, opts.maxSize);
  } else if (opts.scale !== void 0 && opts.scale < 1) {
    target = {
      width: Math.max(1, Math.round(src.width * opts.scale)),
      height: Math.max(1, Math.round(src.height * opts.scale))
    };
  }
  if (target.width >= src.width && target.height >= src.height) {
    return { path: srcPath, width: src.width, height: src.height, scaled: false };
  }
  const out = resizeArea(src, target.width, target.height);
  fs14.writeFileSync(dstPath, encodePng(out));
  return { path: dstPath, width: out.width, height: out.height, scaled: true };
}

// src/tools/render.ts
var AeSnapshotFrameSchema = external_exports.object({
  comp_id: external_exports.number().int().describe("The CompItem ID to snapshot."),
  time: external_exports.number().min(0).describe("Composition time in seconds at which to capture the frame."),
  scale: external_exports.number().gt(0).max(1).default(0.5).optional().describe(
    "Size of the returned PNG as a fraction of the comp (default 0.5). AE always renders at full resolution (changing the comp's resolution would put steps on the user's undo stack); the server shrinks the PNG afterwards and keeps the full-size file as `full_path`."
  ),
  max_size: external_exports.number().int().min(16).max(8192).optional().describe(
    "Long edge in pixels of the returned PNG. Overrides `scale`. 512 to 1024 is enough for most visual checks and costs far fewer image tokens."
  )
});
var AeRenderQueueAddSchema = external_exports.object({
  comp_id: external_exports.number().int().describe("The CompItem ID to add to the Render Queue."),
  output_path: external_exports.string().min(1).describe("Absolute file path for the rendered output."),
  output_module_template: external_exports.string().optional().describe("Optional Output Module template name."),
  render_settings_template: external_exports.string().optional().describe("Optional Render Settings template name."),
  expect: ExpectSchema
});
var AeRenderQueueStatusSchema = external_exports.object({});
function defaultFramesDir() {
  return path15.join(defaultDataDir(), "frames");
}
function isFreshPngFile(filePath, requestStartMs) {
  try {
    if (!fs15.existsSync(filePath)) {
      return { fresh: false, size: 0, mtimeMs: 0 };
    }
    const stat = fs15.statSync(filePath);
    const fresh = stat.size > 0 && stat.mtimeMs >= requestStartMs - 50;
    return { fresh, size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return { fresh: false, size: 0, mtimeMs: 0 };
  }
}
async function waitForFreshPng(filePath, requestStartMs, timeoutMs = 1e4, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let last = isFreshPngFile(filePath, requestStartMs);
  for (; ; ) {
    if (Date.now() >= deadline) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
    const next = isFreshPngFile(filePath, requestStartMs);
    if (next.fresh && last.fresh && next.size === last.size) return next;
    last = next;
  }
}
function snapshotOutput(fullPath, check, scale, maxSize) {
  const copy = writeScaledCopy(fullPath, fullPath.replace(/\.png$/i, "_small.png"), {
    scale,
    maxSize
  });
  return {
    path: copy.path,
    full_path: fullPath,
    size: copy.scaled ? fs15.statSync(copy.path).size : check.size,
    mtimeMs: check.mtimeMs,
    width: copy.width,
    height: copy.height
  };
}
var renderTools = [
  {
    name: "ae_snapshot_frame",
    description: "Render a single frame of a composition to a unique PNG path in `%LOCALAPPDATA%\\chroma-ae-mcp\\frames\\`. saveFrameToPng writes asynchronously, so the server waits (up to 10 s) for the file to be non-empty and stable, and checks its mtime is newer than the request; if not, retries once with a slight time nudge (+0.001s), and if still invalid reports `stale_frame`. `path` is the PNG at the requested `scale` or `max_size` (shrunk on the server), `full_path` the full-resolution render. " + AGENT_SAFETY_GUIDANCE,
    schema: AeSnapshotFrameSchema,
    handler: async (args, ctx) => {
      const scale = args.scale ?? 0.5;
      const framesDir = defaultFramesDir();
      fs15.mkdirSync(framesDir, { recursive: true });
      const opId = ctx.bridge.newOpId();
      try {
        return await ctx.queue.run(
          `ae_snapshot_frame(${args.comp_id} @ ${args.time}s)`,
          async () => {
            const uniqueSuffix1 = `${Date.now()}_${crypto2.randomBytes(4).toString("hex")}`;
            const pngPath1 = path15.join(
              framesDir,
              `frame_c${args.comp_id}_${uniqueSuffix1}.png`
            );
            const reqStart1 = Date.now();
            const resp1 = await ctx.bridge.evalRaw({
              id: `${opId}_try1`,
              script: buildJsxCall("snapshotFrame", {
                comp_id: args.comp_id,
                time: args.time,
                scale,
                output_path: pngPath1
              }),
              label: `ae_snapshot_frame(${args.comp_id} @ ${args.time}s)`,
              timeoutMs: SLOW_TIMEOUT_MS,
              mutates: false,
              toolName: "ae_snapshot_frame"
            });
            const check1 = await waitForFreshPng(pngPath1, reqStart1);
            if (check1.fresh) {
              return {
                ok: true,
                ...snapshotOutput(pngPath1, check1, scale, args.max_size),
                comp_id: args.comp_id,
                // snapshotFrame clamps time to the comp's duration; report what was
                // actually rendered when the host tells us, not the raw request.
                time: resp1.result?.time ?? args.time,
                scale,
                ...args.max_size !== void 0 ? { max_size: args.max_size } : {},
                retried: false,
                comp_width: resp1.result?.width,
                comp_height: resp1.result?.height
              };
            }
            const nudgedTime = Math.max(0, args.time + 1e-3);
            const uniqueSuffix2 = `${Date.now()}_${crypto2.randomBytes(4).toString("hex")}`;
            const pngPath2 = path15.join(
              framesDir,
              `frame_c${args.comp_id}_${uniqueSuffix2}.png`
            );
            const reqStart2 = Date.now();
            const resp2 = await ctx.bridge.evalRaw({
              id: `${opId}_try2`,
              script: buildJsxCall("snapshotFrame", {
                comp_id: args.comp_id,
                time: nudgedTime,
                scale,
                output_path: pngPath2
              }),
              label: `ae_snapshot_frame(${args.comp_id} @ ${nudgedTime}s retry)`,
              timeoutMs: SLOW_TIMEOUT_MS,
              mutates: false,
              toolName: "ae_snapshot_frame"
            });
            const check2 = await waitForFreshPng(pngPath2, reqStart2);
            if (check2.fresh) {
              return {
                ok: true,
                ...snapshotOutput(pngPath2, check2, scale, args.max_size),
                comp_id: args.comp_id,
                time: resp2.result?.time ?? nudgedTime,
                scale,
                ...args.max_size !== void 0 ? { max_size: args.max_size } : {},
                retried: true,
                comp_width: resp2.result?.width,
                comp_height: resp2.result?.height
              };
            }
            return {
              ok: false,
              error: "stale_frame",
              kind: "stale_frame",
              message: "saveFrameToPng did not produce a fresh non-empty PNG after retrying with a time nudge.",
              comp_id: args.comp_id,
              time: args.time,
              scale,
              retried: true,
              attempts: [
                { path: pngPath1, size: check1.size, mtimeMs: check1.mtimeMs },
                { path: pngPath2, size: check2.size, mtimeMs: check2.mtimeMs }
              ]
            };
          }
        );
      } catch (err) {
        if (err instanceof QueueWaitError) {
          throw new BridgeError({
            kind: "queued",
            op_id: opId,
            message: err.message
          });
        }
        throw err;
      }
    }
  },
  {
    name: "ae_render_queue_add",
    description: "Add a composition to the After Effects Render Queue with an output path and optional templates, guarded by `expect`, returning the RQ item index and a before/after receipt. " + AGENT_SAFETY_GUIDANCE,
    schema: AeRenderQueueAddSchema,
    handler: async (args, ctx) => {
      ctx.quarantine.assertClear();
      const opId = ctx.bridge.newOpId();
      const effectiveExpect = {
        project_path: args.expect.project_path,
        comp_id: args.expect.comp_id ?? args.comp_id
      };
      try {
        return await ctx.queue.run(
          `ae_render_queue_add(${args.comp_id})`,
          async () => {
            ctx.quarantine.assertClear();
            const guard = await verifyTargetGuard(ctx, effectiveExpect, opId);
            const checkpoint = await autoCheckpoint(ctx, guard, "ae_render_queue_add");
            const beforeRq = await ctx.bridge.evalRaw({
              id: `${opId}_before`,
              script: buildJsxCall("rqStatus", {}),
              label: "ae_render_queue_add (before rqStatus)",
              mutates: false,
              toolName: "ae_render_queue_add"
            });
            const addResp = await ctx.bridge.evalRaw({
              id: opId,
              script: buildJsxCall("rqAdd", {
                comp_id: args.comp_id,
                output_path: args.output_path,
                output_module_template: args.output_module_template,
                render_settings_template: args.render_settings_template,
                expect: effectiveExpect
              }),
              label: `ae_render_queue_add(${args.comp_id})`,
              timeoutMs: SLOW_TIMEOUT_MS,
              mutates: true,
              toolName: "ae_render_queue_add"
            });
            const afterRq = await ctx.bridge.evalRaw({
              id: `${opId}_after`,
              script: buildJsxCall("rqStatus", {}),
              label: "ae_render_queue_add (after rqStatus)",
              mutates: false,
              toolName: "ae_render_queue_add"
            });
            const rqIndex = typeof addResp.result?.index === "number" ? addResp.result.index : typeof addResp.result?.rq_index === "number" ? addResp.result.rq_index : void 0;
            const afterItems = Array.isArray(afterRq.result?.items) ? afterRq.result.items : [];
            const receipt = buildReceipt({
              before: beforeRq.result,
              after: afterRq.result,
              expected: rqIndex !== void 0 ? { rq_item_present: true } : void 0,
              actualForExpected: rqIndex !== void 0 ? {
                rq_item_present: afterItems.length >= rqIndex || afterItems.some((item) => item.index === rqIndex)
              } : void 0
            });
            return {
              op_id: opId,
              applied: true,
              index: rqIndex,
              result: addResp.result,
              checkpoint,
              receipt
            };
          }
        );
      } catch (err) {
        if (err instanceof QueueWaitError) {
          throw new BridgeError({
            kind: "queued",
            op_id: opId,
            message: err.message
          });
        }
        throw err;
      }
    }
  },
  {
    name: "ae_render_queue_status",
    description: "Read all items currently in the After Effects Render Queue (comp, status, output paths). " + AGENT_SAFETY_GUIDANCE,
    schema: AeRenderQueueStatusSchema,
    handler: async (_args, ctx) => {
      const res = await ctx.bridge.callHost(
        "rqStatus",
        {},
        {
          label: "ae_render_queue_status",
          mutates: false,
          toolName: "ae_render_queue_status"
        }
      );
      return res.result;
    }
  }
];

// src/tools/ext/frames.ts
var AeCompareFramesSchema = external_exports.object({
  comp_id: external_exports.number().int().optional().describe(
    "CompItem ID to capture frames from (use with `times`, mutually exclusive with `a_path`/`b_path`)."
  ),
  times: external_exports.array(external_exports.number().min(0)).min(2).max(20).optional().describe(
    "2 to 20 composition times in seconds to snapshot and compare sequentially."
  ),
  a_path: external_exports.string().min(1).optional().describe(
    "Absolute path to the first PNG file on disk (use with `b_path`, mutually exclusive with `comp_id`/`times`)."
  ),
  b_path: external_exports.string().min(1).optional().describe(
    "Absolute path to the second PNG file on disk (use with `a_path`, mutually exclusive with `comp_id`/`times`)."
  ),
  threshold: external_exports.number().min(0).max(1).default(0.02).describe(
    "Per-pixel channel difference threshold in [0..1] above which a pixel is counted as changed (default: 0.02)."
  ),
  write_diff_png: external_exports.boolean().default(false).describe(
    "If true, writes a visual diff PNG for each compared pair to %LOCALAPPDATA%\\chroma-ae-mcp\\frames."
  ),
  diff_png: external_exports.boolean().optional().describe(
    "Optional alias for `write_diff_png` to write diff PNGs to %LOCALAPPDATA%\\chroma-ae-mcp\\frames."
  )
}).superRefine((val, ctx) => {
  const hasComp = val.comp_id !== void 0;
  const hasTimes = val.times !== void 0;
  const hasA = val.a_path !== void 0;
  const hasB = val.b_path !== void 0;
  if (hasComp !== hasTimes) {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      path: hasComp ? ["times"] : ["comp_id"],
      message: "Both `comp_id` and `times` (2 to 20 entries) must be provided together."
    });
    return;
  }
  if (hasA !== hasB) {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      path: hasA ? ["b_path"] : ["a_path"],
      message: "Both `a_path` and `b_path` must be provided together."
    });
    return;
  }
  const modeComp = hasComp && hasTimes;
  const modePaths = hasA && hasB;
  if (!modeComp && !modePaths) {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      path: ["comp_id"],
      message: "Provide either `{ comp_id, times }` (2 to 20 times) or `{ a_path, b_path }`."
    });
    return;
  }
  if (modeComp && modePaths) {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      path: ["a_path"],
      message: "Provide either `{ comp_id, times }` or `{ a_path, b_path }`, not both."
    });
  }
});
function decodePngFile(filePath) {
  if (!fs16.existsSync(filePath)) {
    throw new Error(`PNG file not found: ${filePath}`);
  }
  const buf = fs16.readFileSync(filePath);
  if (buf.length === 0) {
    throw new Error(`PNG file is empty (0 bytes): ${filePath}`);
  }
  return import_pngjs2.PNG.sync.read(buf);
}
function analyzeDecodedFrame(png, meta) {
  const { width, height, data } = png;
  const totalPixels = width * height;
  if (totalPixels <= 0 || data.length < totalPixels * 4) {
    return {
      index: meta.index,
      path: meta.path,
      ...meta.time !== void 0 ? { time: meta.time } : {},
      width,
      height,
      is_blank: true,
      is_black: false,
      is_transparent: true,
      is_uniform: true,
      flags: ["blank", "transparent"],
      mean_rgba: [0, 0, 0, 0]
    };
  }
  const r0 = data[0];
  const g0 = data[1];
  const b0 = data[2];
  const a0 = data[3];
  let isUniform = true;
  let allTransparent = true;
  let allBlack = true;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let sumA = 0;
  for (let i = 0; i < totalPixels * 4; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];
    sumR += r;
    sumG += g;
    sumB += b;
    sumA += a;
    if (a > 0) {
      allTransparent = false;
      if (r > 1 || g > 1 || b > 1) {
        allBlack = false;
      }
    }
    if (isUniform && (Math.abs(r - r0) > 1 || Math.abs(g - g0) > 1 || Math.abs(b - b0) > 1 || Math.abs(a - a0) > 1)) {
      isUniform = false;
    }
  }
  const isTransparent = allTransparent;
  const isBlack = !allTransparent && allBlack;
  const isBlank2 = isTransparent || isBlack || isUniform;
  const flags = [];
  if (isBlank2) flags.push("blank");
  if (isBlack) flags.push("black");
  if (isTransparent) flags.push("transparent");
  const round4 = (n) => Math.round(n * 1e4) / 1e4;
  return {
    index: meta.index,
    path: meta.path,
    ...meta.time !== void 0 ? { time: meta.time } : {},
    width,
    height,
    is_blank: isBlank2,
    is_black: isBlack,
    is_transparent: isTransparent,
    is_uniform: isUniform,
    flags,
    mean_rgba: [
      round4(sumR / (totalPixels * 255)),
      round4(sumG / (totalPixels * 255)),
      round4(sumB / (totalPixels * 255)),
      round4(sumA / (totalPixels * 255))
    ]
  };
}
function compareDecodedFrames(pngA, pngB, options = {}) {
  if (pngA.width !== pngB.width || pngA.height !== pngB.height) {
    throw new Error(
      `Frame dimensions do not match: ${pngA.width}x${pngA.height} vs ${pngB.width}x${pngB.height}`
    );
  }
  const width = pngA.width;
  const height = pngA.height;
  const totalPixels = width * height;
  const threshold = options.threshold ?? 0.02;
  const buildDiff = Boolean(options.buildDiffPng);
  const diffPng = buildDiff ? new import_pngjs2.PNG({ width, height }) : void 0;
  if (totalPixels === 0) {
    return {
      width,
      height,
      mean_abs_diff: 0,
      max_diff: 0,
      threshold,
      changed_pixels: 0,
      total_pixels: 0,
      pct_pixels_changed: 0,
      percent_changed: 0,
      identical: true,
      diffPng
    };
  }
  let sumAbsDiff = 0;
  let maxDiff = 0;
  let changedPixels = 0;
  const dataA = pngA.data;
  const dataB = pngB.data;
  for (let i = 0; i < totalPixels * 4; i += 4) {
    const dr = Math.abs(dataA[i] - dataB[i]) / 255;
    const dg = Math.abs(dataA[i + 1] - dataB[i + 1]) / 255;
    const db = Math.abs(dataA[i + 2] - dataB[i + 2]) / 255;
    const da = Math.abs(dataA[i + 3] - dataB[i + 3]) / 255;
    const pixelMean = (dr + dg + db + da) / 4;
    const pixelMax = Math.max(dr, dg, db, da);
    sumAbsDiff += pixelMean;
    if (pixelMax > maxDiff) {
      maxDiff = pixelMax;
    }
    const isChanged = pixelMax > threshold;
    if (isChanged) {
      changedPixels++;
    }
    if (diffPng) {
      if (isChanged) {
        const intensity = Math.min(
          255,
          Math.max(64, Math.round(pixelMax * 255))
        );
        diffPng.data[i] = intensity;
        diffPng.data[i + 1] = Math.round(dg * 128);
        diffPng.data[i + 2] = intensity;
        diffPng.data[i + 3] = 255;
      } else {
        const luma = Math.round(
          (dataA[i] * 0.299 + dataA[i + 1] * 0.587 + dataA[i + 2] * 0.114) * 0.25
        );
        diffPng.data[i] = luma;
        diffPng.data[i + 1] = luma;
        diffPng.data[i + 2] = luma;
        diffPng.data[i + 3] = 255;
      }
    }
  }
  const round6 = (n) => Math.round(n * 1e6) / 1e6;
  const meanAbsDiff = round6(sumAbsDiff / totalPixels);
  const maxDiffRounded = round6(maxDiff);
  const pctChanged = round6(changedPixels / totalPixels * 100);
  return {
    width,
    height,
    mean_abs_diff: meanAbsDiff,
    max_diff: maxDiffRounded,
    threshold,
    changed_pixels: changedPixels,
    total_pixels: totalPixels,
    pct_pixels_changed: pctChanged,
    percent_changed: pctChanged,
    identical: maxDiff === 0,
    diffPng
  };
}
async function captureCompFrame(params) {
  const { ctx, opId, compId, time, frameIndex, framesDir } = params;
  const toolName = params.toolName ?? "ae_compare_frames";
  const suffix1 = `${Date.now()}_${crypto3.randomBytes(4).toString("hex")}`;
  const pngPath1 = path16.join(
    framesDir,
    `frame_c${compId}_f${frameIndex}_${suffix1}.png`
  );
  const reqStart1 = Date.now();
  await ctx.bridge.evalRaw({
    id: `${opId}_f${frameIndex}_try1`,
    script: buildJsxCall("snapshotFrame", {
      comp_id: compId,
      time,
      scale: 0.5,
      output_path: pngPath1
    }),
    label: `${toolName}(${compId} @ ${time}s)`,
    timeoutMs: SLOW_TIMEOUT_MS,
    mutates: false,
    toolName
  });
  const check1 = await waitForFreshPng(pngPath1, reqStart1, params.waitMs);
  if (check1.fresh) {
    return { path: pngPath1, time };
  }
  const nudgedTime = Math.max(0, time + 1e-3);
  const suffix2 = `${Date.now()}_${crypto3.randomBytes(4).toString("hex")}`;
  const pngPath2 = path16.join(
    framesDir,
    `frame_c${compId}_f${frameIndex}_${suffix2}.png`
  );
  const reqStart2 = Date.now();
  await ctx.bridge.evalRaw({
    id: `${opId}_f${frameIndex}_try2`,
    script: buildJsxCall("snapshotFrame", {
      comp_id: compId,
      time: nudgedTime,
      scale: 0.5,
      output_path: pngPath2
    }),
    label: `${toolName}(${compId} @ ${nudgedTime}s retry)`,
    timeoutMs: SLOW_TIMEOUT_MS,
    mutates: false,
    toolName
  });
  const check2 = await waitForFreshPng(pngPath2, reqStart2, params.waitMs);
  if (check2.fresh) {
    return { path: pngPath2, time: nudgedTime };
  }
  throw new Error(
    `saveFrameToPng did not produce a fresh non-empty PNG for comp ${compId} at time ${time}s after retry.`
  );
}
var framesTools = [
  {
    name: "ae_compare_frames",
    description: "Compare 2 to 20 composition frames captured at `times` (via `snapshotFrame` + `waitForFreshPng`) or two existing PNG files (`a_path`, `b_path`). Decodes frames with `pngjs`, flags blank, black, or fully transparent frames, returns pairwise `mean_abs_diff` (0..1), `max_diff` (0..1), and `pct_pixels_changed` over `threshold`, and optionally writes a `diff_png` to `%LOCALAPPDATA%\\chroma-ae-mcp\\frames`. " + AGENT_SAFETY_GUIDANCE,
    schema: AeCompareFramesSchema,
    handler: async (args, ctx) => {
      const threshold = args.threshold ?? 0.02;
      const shouldWriteDiff = Boolean(args.write_diff_png || args.diff_png);
      const framesDir = defaultFramesDir();
      const capturedItems = [];
      if (args.comp_id !== void 0 && args.times !== void 0) {
        fs16.mkdirSync(framesDir, { recursive: true });
        const opId = ctx.bridge.newOpId();
        const compId = args.comp_id;
        const times = args.times;
        try {
          await ctx.queue.run(
            `ae_compare_frames(${compId}, ${times.length} frames)`,
            async () => {
              for (let i = 0; i < times.length; i++) {
                const snap = await captureCompFrame({
                  ctx,
                  opId,
                  compId,
                  time: times[i],
                  frameIndex: i,
                  framesDir
                });
                capturedItems.push({ path: snap.path, time: times[i] });
              }
            }
          );
        } catch (err) {
          if (err instanceof QueueWaitError) {
            throw new BridgeError({
              kind: "queued",
              op_id: opId,
              message: err.message
            });
          }
          throw err;
        }
      } else if (args.a_path !== void 0 && args.b_path !== void 0) {
        capturedItems.push({ path: args.a_path }, { path: args.b_path });
      } else {
        throw new Error(
          "Invalid arguments: provide either { comp_id, times } or { a_path, b_path }."
        );
      }
      if (shouldWriteDiff) {
        fs16.mkdirSync(framesDir, { recursive: true });
      }
      const decodedPngs = [];
      const frameAnalyses = [];
      for (let i = 0; i < capturedItems.length; i++) {
        const item = capturedItems[i];
        const png = decodePngFile(item.path);
        decodedPngs.push(png);
        frameAnalyses.push(
          analyzeDecodedFrame(png, {
            index: i,
            path: item.path,
            time: item.time
          })
        );
      }
      const pairs = [];
      const diffPngPaths = [];
      for (let i = 0; i < decodedPngs.length - 1; i++) {
        const itemA = capturedItems[i];
        const itemB = capturedItems[i + 1];
        const cmp = compareDecodedFrames(decodedPngs[i], decodedPngs[i + 1], {
          threshold,
          buildDiffPng: shouldWriteDiff
        });
        let diffPngPath;
        if (shouldWriteDiff && cmp.diffPng) {
          const suffix = `${Date.now()}_${crypto3.randomBytes(4).toString("hex")}`;
          diffPngPath = path16.join(framesDir, `diff_${i}_${i + 1}_${suffix}.png`);
          const outBuf = import_pngjs2.PNG.sync.write(cmp.diffPng);
          fs16.writeFileSync(diffPngPath, outBuf);
          diffPngPaths.push(diffPngPath);
        }
        pairs.push({
          pair_index: i,
          a_index: i,
          b_index: i + 1,
          a_path: itemA.path,
          b_path: itemB.path,
          ...itemA.time !== void 0 ? { a_time: itemA.time } : {},
          ...itemB.time !== void 0 ? { b_time: itemB.time } : {},
          width: cmp.width,
          height: cmp.height,
          mean_abs_diff: cmp.mean_abs_diff,
          max_diff: cmp.max_diff,
          threshold: cmp.threshold,
          changed_pixels: cmp.changed_pixels,
          total_pixels: cmp.total_pixels,
          pct_pixels_changed: cmp.pct_pixels_changed,
          percent_changed: cmp.percent_changed,
          identical: cmp.identical,
          ...diffPngPath ? { diff_png: diffPngPath } : {}
        });
      }
      const flaggedFrames = frameAnalyses.filter((f) => f.flags.length > 0).map((f) => ({
        index: f.index,
        path: f.path,
        ...f.time !== void 0 ? { time: f.time } : {},
        flags: f.flags
      }));
      const firstPair = pairs[0];
      return {
        ok: true,
        mode: args.comp_id !== void 0 ? "comp_times" : "file_pair",
        ...args.comp_id !== void 0 ? { comp_id: args.comp_id } : {},
        threshold,
        frames: frameAnalyses,
        flagged_frames: flaggedFrames,
        pairs,
        // Convenience top-level summary fields when comparing a single pair
        ...firstPair ? {
          mean_abs_diff: firstPair.mean_abs_diff,
          max_diff: firstPair.max_diff,
          pct_pixels_changed: firstPair.pct_pixels_changed,
          percent_changed: firstPair.percent_changed,
          ...firstPair.diff_png ? { diff_png: firstPair.diff_png } : {}
        } : {},
        ...diffPngPaths.length > 0 ? { diff_pngs: diffPngPaths } : {}
      };
    }
  }
];

// src/tools/ext/key.ts
var fs17 = __toESM(require("node:fs"), 1);
var path17 = __toESM(require("node:path"), 1);
function screenLean(r, g, b, dominant, screenLeanValue) {
  const lean = dominant === 1 ? g - Math.max(r, b) : b - Math.max(r, g);
  return screenLeanValue > 0 ? lean / screenLeanValue : 0;
}
function detectScreenColor(img, minCoverage = 0.1) {
  const n = img.width * img.height;
  const pick = (dominant) => {
    const rs = [];
    const gs = [];
    const bs = [];
    for (let i = 0; i < n; i++) {
      const j = i * 4;
      if (img.data[j + 3] < 250) continue;
      const r = img.data[j] / 255;
      const g = img.data[j + 1] / 255;
      const b = img.data[j + 2] / 255;
      const lean = dominant === 1 ? g - Math.max(r, b) : b - Math.max(r, g);
      if (lean > 0.15) {
        rs.push(r);
        gs.push(g);
        bs.push(b);
      }
    }
    return { rs, gs, bs, coverage: rs.length / n };
  };
  const green = pick(1);
  const blue = pick(2);
  const best = green.coverage >= blue.coverage ? { ...green, kind: "green" } : { ...blue, kind: "blue" };
  if (best.coverage < minCoverage) return null;
  const median = (v) => {
    const s = [...v].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  const round = (v) => Math.round(v * 1e3) / 1e3;
  return { color: [round(median(best.rs)), round(median(best.gs)), round(median(best.bs))], kind: best.kind, coverage: round(best.coverage) };
}
function measureKey(before, after, screen, edge = 3) {
  const { width: w, height: h } = before;
  if (after.width !== w || after.height !== h) throw new Error("Before and after frames differ in size");
  const dominant = screen[1] >= screen[2] ? 1 : 2;
  const sLean = dominant === 1 ? screen[1] - Math.max(screen[0], screen[2]) : screen[2] - Math.max(screen[0], screen[1]);
  const n = w * h;
  const cls = new Uint8Array(n);
  const leanBefore = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const j = i * 4;
    const lean = screenLean(before.data[j] / 255, before.data[j + 1] / 255, before.data[j + 2] / 255, dominant, sLean);
    leanBefore[i] = lean;
    if (lean >= 0.7) cls[i] = 1;
    else if (lean < 0.2 && before.data[j + 3] > 250) cls[i] = 2;
  }
  const nearScreen = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (cls[y * w + x] !== 1) continue;
      for (let dy = -edge; dy <= edge; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -edge; dx <= edge; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < w) nearScreen[yy * w + xx] = 1;
        }
      }
    }
  }
  let screenCount = 0;
  let screenLeft = 0;
  let residual = 0;
  let subject = 0;
  let holes = 0;
  let spillB = 0;
  let spillA = 0;
  let spillN = 0;
  let shift = 0;
  let recoloured = 0;
  for (let i = 0; i < n; i++) {
    const j = i * 4;
    const a = after.data[j + 3] / 255;
    if (cls[i] === 1) {
      screenCount++;
      residual += a;
      if (a > 0.05) screenLeft++;
    } else if (cls[i] === 2 && !nearScreen[i]) {
      subject++;
      if (a < 0.95) holes++;
      if (a > 0.5) {
        spillB += Math.max(0, leanBefore[i] * sLean);
        spillA += Math.max(0, screenLean(after.data[j] / 255, after.data[j + 1] / 255, after.data[j + 2] / 255, dominant, 1));
        const dr = Math.abs(after.data[j] - before.data[j]);
        const dg = Math.abs(after.data[j + 1] - before.data[j + 1]);
        const db = Math.abs(after.data[j + 2] - before.data[j + 2]);
        shift += (dr + dg + db) / (3 * 255);
        if (Math.max(dr, dg, db) / 255 > 0.12) recoloured++;
        spillN++;
      }
    }
  }
  const pct = (v, of) => of > 0 ? Math.round(v / of * 1e4) / 100 : 0;
  const r4 = (v) => Math.round(v * 1e4) / 1e4;
  return {
    screen_pixels_pct: pct(screenCount, n),
    subject_pixels_pct: pct(subject, n),
    screen_left_pct: pct(screenLeft, screenCount),
    screen_residual_alpha: screenCount ? r4(residual / screenCount) : 0,
    holes_pct: pct(holes, subject),
    spill_before: spillN ? r4(spillB / spillN) : 0,
    spill_after: spillN ? r4(spillA / spillN) : 0,
    subject_color_shift: spillN ? r4(shift / spillN) : 0,
    recoloured_pct: pct(recoloured, spillN)
  };
}
function worstMetrics(all) {
  const max = (k) => Math.max(...all.map((m) => m[k]));
  return {
    screen_pixels_pct: Math.min(...all.map((m) => m.screen_pixels_pct)),
    subject_pixels_pct: Math.min(...all.map((m) => m.subject_pixels_pct)),
    screen_left_pct: max("screen_left_pct"),
    screen_residual_alpha: max("screen_residual_alpha"),
    holes_pct: max("holes_pct"),
    spill_before: max("spill_before"),
    spill_after: max("spill_after"),
    subject_color_shift: max("subject_color_shift"),
    recoloured_pct: max("recoloured_pct")
  };
}
function keyAdvice(m, kl, target) {
  const findings = [];
  const fix = (param, value) => ({
    tool: "ae_set_effect",
    args: {
      comp_id: target.comp_id,
      layer: { id: target.layer_id },
      effect: { index: kl.index },
      params: [{ param, value: Math.round(value * 10) / 10 }],
      expect: target.expect
    }
  });
  if (m.screen_left_pct >= 0.5) {
    const next = Math.max(kl.clip_black + 1, Math.min(kl.clip_white - 1, kl.clip_black + (m.screen_left_pct > 5 ? 20 : 10)));
    findings.push({
      issue: "screen_left",
      message: `${m.screen_left_pct}% of the screen is still visible (mean alpha ${m.screen_residual_alpha}). Raising Clip Black from ${kl.clip_black} to ${next} pushes it out.`,
      fix: fix("Keylight 906-0012", next)
    });
  }
  if (m.holes_pct >= 0.5) {
    const next = Math.min(kl.clip_white - 1, Math.max(kl.clip_black + 1, kl.clip_white - (m.holes_pct > 5 ? 20 : 10)));
    findings.push({
      issue: "holes",
      message: `${m.holes_pct}% of the subject is see-through. Lowering Clip White from ${kl.clip_white} to ${next} fills it in; if the subject itself is greenish, lower Screen Gain instead.`,
      fix: fix("Keylight 906-0013", next)
    });
  }
  if (m.spill_after > 0.05) {
    findings.push({
      issue: "spill",
      message: `The subject still leans to the screen colour (spill ${m.spill_after}, ${m.spill_before} before). Raise Suppression on Advanced Spill Suppressor.`
    });
  }
  if (m.subject_color_shift > 0.06 || m.recoloured_pct > 2) {
    findings.push({
      issue: "color_shift",
      message: `The key recoloured ${m.recoloured_pct}% of the subject (mean shift ${m.subject_color_shift} per channel). Despill takes the screen colour out of anything greenish (or bluish) on the subject; compare in the preview, and if a prop or costume changed, set Keylight's Despill Bias to that colour or mask the area.`
    });
  }
  return { verdict: findings.length === 0 ? "clean" : "needs_work", findings };
}
function keyPreview(pairs, tile = 480) {
  const fit = fitWithin(pairs[0].before.width, pairs[0].before.height, tile);
  const gap = 6;
  const out = createCanvas(fit.width * 2 + gap * 3, (fit.height + gap) * pairs.length + gap, [24, 24, 24, 255]);
  pairs.forEach((p, row) => {
    const y = gap + row * (fit.height + gap);
    blit(out, resizeArea(p.before, fit.width, fit.height), gap, y);
    blit(out, flattenOnChecker(resizeArea(p.after, fit.width, fit.height), 8, 90, 60), gap * 2 + fit.width, y);
  });
  return out;
}
function keyTimes(info) {
  const fps = info.comp.fps > 0 ? info.comp.fps : 25;
  const start = Math.max(info.layer.inPoint, info.comp.workAreaStart);
  const end = Math.min(info.layer.outPoint, info.comp.workAreaStart + info.comp.workAreaDuration) - 1 / fps;
  if (end < start) return [Math.round(start * fps) / fps];
  const snap = (t) => Math.round(t * fps) / fps;
  return [.../* @__PURE__ */ new Set([snap(start), snap((start + end) / 2), snap(end)])];
}
var AeKeyGreenScreenSchema = external_exports.object({
  comp_id: external_exports.number().int(),
  layer: LayerSelectorSchema.describe("The plate layer to key."),
  times: external_exports.array(external_exports.number().min(0)).min(1).max(5).optional().describe("Frames to analyse and check, in seconds. Default: start, middle and end of the layer within the work area."),
  screen_color: external_exports.array(external_exports.number().min(0).max(1)).length(3).optional().describe("Screen colour [r, g, b] in 0..1. Default: detected from the plate."),
  clip_black: external_exports.number().min(0).max(100).optional().describe("Keylight Clip Black: raise it when screen is left behind."),
  clip_white: external_exports.number().min(0).max(100).optional().describe("Keylight Clip White: lower it when the subject has holes."),
  screen_gain: external_exports.number().min(0).max(200).optional().describe("Keylight Screen Gain (default 100)."),
  screen_balance: external_exports.number().min(0).max(100).optional(),
  screen_softness: external_exports.number().min(0).max(100).optional(),
  screen_shrink_grow: external_exports.number().min(-100).max(100).optional(),
  cleanup: external_exports.boolean().optional().describe("Also add Key Cleaner and Advanced Spill Suppressor (default true)."),
  check_only: external_exports.boolean().optional().describe("Only measure the current key; changes nothing."),
  expect: ExpectSchema.optional().describe("Required unless check_only.")
}).refine((v) => v.check_only === true || v.expect !== void 0, { message: "Keying needs expect; pass check_only to only measure." });
var beforeFrames = /* @__PURE__ */ new Map();
var beforeKey = (compId, layerId, t) => `${compId}:${layerId}:${t.toFixed(4)}`;
async function queued(ctx, label, opId, fn) {
  try {
    return await ctx.queue.run(label, fn);
  } catch (err) {
    if (err instanceof QueueWaitError) throw new BridgeError({ kind: "queued", op_id: opId, message: err.message });
    throw err;
  }
}
var KEYLIGHT_ARG_KEYS = ["clip_black", "clip_white", "screen_gain", "screen_balance", "screen_softness", "screen_shrink_grow"];
var keyTools = [
  {
    name: "ae_key_greenscreen",
    description: "Key a green or blue screen plate with AE's own Keylight (1.2), plus Key Cleaner and Advanced Spill Suppressor, in one undo step guarded by `expect`; then CHECK the key. Frames rendered before keying tell screen from subject (the screen colour is detected from them unless given); frames rendered after are measured: `screen_left_pct` (screen still visible), `holes_pct` (see-through subject), `spill_after` (screen colour on the subject). The result has `verdict`, `findings` with ready ae_set_effect fixes (apply them with the user's OK, then call again with check_only), and `preview_path`: before and after over a checkerboard, one row per frame. Look at it. A layer that already has Keylight is re-tuned, not keyed twice. The check needs the plate to be the lowest visible layer (precomp it otherwise); without frames from before the key (another session, or a key made by hand) only the preview is returned. " + AGENT_SAFETY_GUIDANCE,
    schema: AeKeyGreenScreenSchema,
    handler: async (args, ctx) => {
      const opId = ctx.bridge.newOpId();
      const framesDir = defaultFramesDir();
      fs17.mkdirSync(framesDir, { recursive: true });
      const label = `ae_key_greenscreen(${args.comp_id})`;
      const readInfo = async (times, suffix) => (await ctx.bridge.evalRaw({
        id: `${opId}_${suffix}`,
        script: buildJsxCall("keyLayerInfo", { comp_id: args.comp_id, layer: args.layer, times }),
        label: `${label} ${suffix}`,
        mutates: false,
        toolName: "ae_key_greenscreen"
      })).result;
      const capture = async (t, i) => (await captureCompFrame({ ctx, opId, compId: args.comp_id, time: t, frameIndex: i, framesDir, toolName: "ae_key_greenscreen" })).path;
      const run = await queued(ctx, label, opId, async () => {
        const first = await readInfo(args.times, "info");
        const times = args.times ?? keyTimes(first);
        const info = args.times ? first : await readInfo(times, "info2");
        const layerId = info.layer.id;
        const before = [];
        for (let i = 0; i < times.length; i++) {
          const k = beforeKey(args.comp_id, layerId, times[i]);
          if (!info.keylight && !args.check_only) {
            const p = await capture(times[i], i);
            beforeFrames.set(k, p);
            before.push(p);
          } else {
            before.push(beforeFrames.get(k) ?? null);
          }
        }
        let screen = args.screen_color ?? null;
        let detected = null;
        if (!screen && info.keylight) screen = info.keylight.screen_colour.slice(0, 3);
        if (!screen && before[0]) {
          detected = detectScreenColor(decodePngFile(before[0]));
          screen = detected?.color ?? null;
        }
        let write = null;
        if (!args.check_only) {
          if (!screen) {
            return { error: "no_screen", times };
          }
          const expect = { project_path: args.expect.project_path, comp_id: args.expect.comp_id ?? args.comp_id };
          const guard = await verifyTargetGuard(ctx, expect, opId);
          const checkpoint = await autoCheckpoint(ctx, guard, "ae_key_greenscreen");
          const params = {};
          for (const k of KEYLIGHT_ARG_KEYS) if (args[k] !== void 0) params[k] = args[k];
          const res = await ctx.bridge.evalRaw({
            id: opId,
            script: buildJsxCall("applyGreenScreenKey", {
              comp_id: args.comp_id,
              layer: { id: layerId },
              screen_color: screen,
              cleanup: args.cleanup ?? true,
              expect,
              ...params
            }),
            label: `${label} key`,
            mutates: true,
            toolName: "ae_key_greenscreen"
          });
          const after2 = await readInfo(times, "after");
          write = { checkpoint, result: res.result, after: after2 };
        }
        const after = [];
        for (let i = 0; i < times.length; i++) after.push(await capture(times[i], times.length + i));
        const finalInfo = write?.after ?? info;
        return { times, before, after, screen, detected, write, info: finalInfo };
      });
      if ("error" in run) {
        return {
          ok: false,
          error: "no_screen",
          message: "No green or blue screen covers at least 10% of the plate. Pass screen_color, or check that the layer is the plate."
        };
      }
      const kl = run.info.keylight;
      const pairs = run.after.map((a, i) => ({ before: run.before[i] ? decodePngFile(run.before[i]) : null, after: decodePngFile(a) }));
      const previewPath = path17.join(framesDir, `key_c${args.comp_id}_${opId}.png`);
      fs17.writeFileSync(previewPath, encodePng(keyPreview(pairs.map((p) => ({ before: p.before ?? p.after, after: p.after })))));
      const below = run.info.layers_below_visible;
      const canMeasure = below.length === 0 && pairs.every((p) => p.before !== null) && run.screen !== null;
      const perFrame = canMeasure ? pairs.map((p) => measureKey(p.before, p.after, run.screen)) : [];
      const worst = perFrame.length ? worstMetrics(perFrame) : null;
      const target = {
        comp_id: args.comp_id,
        layer_id: run.info.layer.id,
        expect: { project_path: run.info.project_path, comp_id: args.comp_id }
      };
      const advice = worst && kl ? keyAdvice(worst, kl, target) : null;
      let receipt;
      if (run.write) {
        const mismatches = [];
        if (!kl) {
          mismatches.push({ path: "keylight", expected: "present", actual: null, message: "No Keylight on the layer after keying" });
        } else {
          compareValues([...run.screen, 1], kl.screen_colour, "keylight.screen_colour", mismatches);
          for (const k of KEYLIGHT_ARG_KEYS) if (args[k] !== void 0) compareValues(args[k], kl[k], `keylight.${k}`, mismatches);
        }
        if ((args.cleanup ?? true) && !(run.info.has_key_cleaner && run.info.has_spill_suppressor)) {
          mismatches.push({ path: "cleanup", expected: "Key Cleaner and Advanced Spill Suppressor", actual: run.info, message: "Cleanup effects missing after keying" });
        }
        receipt = buildReceipt({ before: null, after: run.info, customMismatches: mismatches });
      }
      let note;
      if (below.length > 0) note = `Layers below the plate show through (${below.join(", ")}), so the alpha can't be measured; precomp the plate or check the preview.`;
      else if (!canMeasure) note = "No frames from before the key are kept for this layer (a key made by hand or in another session), so only the preview is returned.";
      return {
        ok: true,
        applied: run.write !== null,
        layer: run.info.layer,
        times: run.times,
        screen_color: run.screen,
        ...run.detected ? { screen_detected: { kind: run.detected.kind, coverage: run.detected.coverage } } : {},
        keylight: kl,
        ...run.write ? { added: run.write.result.added, checkpoint: run.write.checkpoint, receipt } : {},
        metrics: worst,
        per_frame: perFrame.length > 1 ? perFrame : void 0,
        verdict: advice?.verdict ?? "unchecked",
        findings: advice?.findings ?? [],
        ...note ? { note } : {},
        preview_path: previewPath
      };
    }
  }
];

// src/tools/ext/motion.ts
var crypto4 = __toESM(require("node:crypto"), 1);
var fs18 = __toESM(require("node:fs"), 1);
var path18 = __toESM(require("node:path"), 1);
var MAX_SHEET_FRAMES = 24;
var MAX_SHEET_EDGE = 2400;
var SHEET_GAP = 6;
var SHEET_BG = [24, 24, 24, 255];
var FLAG_COLOUR = [230, 40, 40, 255];
var AeContactSheetSchema = external_exports.object({
  comp_id: external_exports.number().int().describe("CompItem ID to sample."),
  times: external_exports.array(external_exports.number().min(0)).min(2).max(MAX_SHEET_FRAMES).optional().describe(
    `Explicit comp times in seconds (2 to ${MAX_SHEET_FRAMES}). Mutually exclusive with start/end/count.`
  ),
  start: external_exports.number().min(0).optional().describe("Range start in comp seconds. Default: the work area start."),
  end: external_exports.number().min(0).optional().describe("Range end in comp seconds (exclusive, like the work area end). Default: the work area end."),
  count: external_exports.number().int().min(2).max(MAX_SHEET_FRAMES).optional().describe(
    `How many frames to sample evenly across the range, first and last frame included (2 to ${MAX_SHEET_FRAMES}, default 12).`
  ),
  tile_size: external_exports.number().int().min(64).max(768).optional().describe(
    `Long edge in pixels of each tile (default 320). Tiles shrink further if the sheet would exceed ${MAX_SHEET_EDGE} px.`
  ),
  columns: external_exports.number().int().min(1).max(12).optional().describe("Number of columns. Default: chosen so the sheet is roughly 16:9."),
  labels: external_exports.boolean().optional().describe("Draw the frame number and time on each tile (default true).")
}).superRefine((val, ctx) => {
  if (val.times !== void 0 && (val.start !== void 0 || val.end !== void 0 || val.count !== void 0)) {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      path: ["times"],
      message: "Give either `times`, or a range (`start`/`end`/`count`), not both."
    });
  }
  if (val.start !== void 0 && val.end !== void 0 && val.end <= val.start) {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      path: ["end"],
      message: "`end` must be after `start`."
    });
  }
});
function contactSheetTimes(comp, opts) {
  const fps = comp.fps > 0 ? comp.fps : 25;
  if (opts.times !== void 0) {
    return opts.times.map((t) => {
      if (t > comp.duration) {
        throw new Error(`Time ${t}s is past the comp's duration (${comp.duration}s).`);
      }
      return { time: t, frame: Math.round(t * fps) };
    });
  }
  const start = opts.start ?? comp.workAreaStart;
  const end = Math.min(opts.end ?? comp.workAreaStart + comp.workAreaDuration, comp.duration);
  if (end <= start) {
    throw new Error(`Empty range: start ${start}s, end ${end}s (comp duration ${comp.duration}s).`);
  }
  const firstFrame = Math.round(start * fps);
  const lastFrame = Math.max(firstFrame, Math.ceil(end * fps - 1e-6) - 1);
  const span = lastFrame - firstFrame;
  if (span === 0) {
    throw new Error(
      `Range ${start}s to ${end}s covers only one frame at ${fps}fps; widen it to sample at least 2 frames.`
    );
  }
  const count = Math.min(opts.count ?? 12, span + 1);
  const frames = [];
  for (let i = 0; i < count; i++) {
    const f = count === 1 ? firstFrame : Math.round(firstFrame + i * span / (count - 1));
    if (frames[frames.length - 1] !== f) frames.push(f);
  }
  return frames.map((frame) => ({ frame, time: frame / fps }));
}
function chooseColumns(n, tileWidth, tileHeight) {
  const cols = Math.round(Math.sqrt(n * (16 / 9) * tileHeight / tileWidth));
  return Math.max(1, Math.min(n, cols));
}
function labelMetrics(tileHeight, labels) {
  const textScale = tileHeight >= 90 ? 2 : 1;
  return { labelHeight: labels ? GLYPH_HEIGHT * textScale + 4 * textScale : 0, textScale };
}
function sheetLayout(n, compWidth, compHeight, tileSize, columns, labels = true) {
  let tile = fitWithin(compWidth, compHeight, tileSize);
  const cols = Math.max(1, Math.min(n, columns ?? chooseColumns(n, tile.width, tile.height)));
  const rows = Math.ceil(n / cols);
  const sheetW = (t) => cols * t.width + (cols + 1) * SHEET_GAP;
  const sheetH = (t) => rows * (t.height + labelMetrics(t.height, labels).labelHeight) + (rows + 1) * SHEET_GAP;
  let longest = Math.max(sheetW(tile), sheetH(tile));
  for (let size = Math.max(tile.width, tile.height); longest > MAX_SHEET_EDGE && size > 16; ) {
    size = Math.max(16, Math.floor(size * MAX_SHEET_EDGE / longest) - 1);
    tile = fitWithin(compWidth, compHeight, size);
    longest = Math.max(sheetW(tile), sheetH(tile));
  }
  const { labelHeight, textScale } = labelMetrics(tile.height, labels);
  return {
    tileWidth: tile.width,
    tileHeight: tile.height,
    labelHeight,
    textScale,
    columns: cols,
    rows,
    width: sheetW(tile),
    height: sheetH(tile)
  };
}
function buildContactSheet(tiles, layout) {
  const sheet = createCanvas(layout.width, layout.height, SHEET_BG);
  const pad = 2 * layout.textScale;
  tiles.forEach((tile, i) => {
    const col = i % layout.columns;
    const row = Math.floor(i / layout.columns);
    const x = SHEET_GAP + col * (layout.tileWidth + SHEET_GAP);
    const y = SHEET_GAP + row * (layout.tileHeight + layout.labelHeight + SHEET_GAP);
    const small = tile.image.width === layout.tileWidth && tile.image.height === layout.tileHeight ? tile.image : resizeArea(tile.image, layout.tileWidth, layout.tileHeight);
    blit(sheet, flattenOnChecker(small, 8, 112, 88), x, y);
    if (tile.label && layout.labelHeight > 0) {
      fillRect(sheet, x, y + layout.tileHeight, layout.tileWidth, layout.labelHeight, [0, 0, 0, 255]);
      drawText(sheet, tile.label, x + pad, y + layout.tileHeight + pad, layout.textScale, [255, 255, 255, 255]);
    }
    if (tile.flagged) {
      strokeRect(sheet, x, y, layout.tileWidth, layout.tileHeight, 3, FLAG_COLOUR);
    }
  });
  return sheet;
}
function frameLabel(sample) {
  return `f${sample.frame} ${sample.time.toFixed(2)}s`;
}
var DIM_COLOURS = [
  [235, 80, 80, 255],
  [90, 200, 90, 255],
  [90, 150, 255, 255],
  [200, 200, 200, 255]
];
var SPEED_COLOUR = [240, 240, 240, 255];
var KEY_COLOUR = [255, 200, 60, 255];
var KEY_LINE = [255, 200, 60, 90];
var PANEL_BG = [40, 40, 40, 255];
var GRID_COLOUR = [62, 62, 62, 255];
var AXIS_LABEL = [200, 200, 200, 255];
var AeMotionGraphSchema = external_exports.object({
  comp_id: external_exports.number().int().describe("CompItem ID that holds the layer."),
  layer: LayerSelectorSchema,
  path: external_exports.array(external_exports.union([external_exports.string().min(1), external_exports.number().int().positive()])).min(1).describe(
    "Property path from the layer, by match name or display name, e.g. ['ADBE Transform Group', 'ADBE Position'] or ['Effects', 'Gaussian Blur', 'Blurriness']. The property must hold a number, vector or colour. A step may be a 1-based positional index instead of a name for a sibling inside an indexed group (effects, masks, shape layer contents), where siblings can share a display name."
  ),
  start: external_exports.number().min(0).optional().describe("Range start in comp seconds. Default: the first keyframe, or the work area start without keyframes."),
  end: external_exports.number().min(0).optional().describe("Range end in comp seconds. Default: the last keyframe, or the work area end without keyframes."),
  step: external_exports.number().positive().optional().describe("Seconds between samples. Default: one comp frame. Capped at 1000 samples by widening the step."),
  width: external_exports.number().int().min(320).max(2048).optional().describe("Graph width in pixels (default 960)."),
  height: external_exports.number().int().min(200).max(2048).optional().describe("Graph height in pixels (default 540)."),
  include_samples: external_exports.boolean().optional().describe("Also return every sample as `sample_table` (default false; the graph and summary are usually enough).")
}).superRefine((val, ctx) => {
  if (val.start !== void 0 && val.end !== void 0 && val.end <= val.start) {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      path: ["end"],
      message: "`end` must be after `start`."
    });
  }
});
function distanceBetween(a, b) {
  let sum = 0;
  for (let d = 0; d < Math.min(a.length, b.length); d++) sum += (b[d] - a[d]) ** 2;
  return Math.sqrt(sum);
}
function sampleSpeeds(s) {
  const jumps = s.keys.filter((_k, i) => i > 0 && s.keys[i - 1].out_interp === "hold").map((k) => k.time);
  const out = [];
  for (let i = 0; i + 1 < s.times.length; i++) {
    const t0 = s.times[i];
    const t1 = s.times[i + 1];
    const isJump = jumps.some((t) => t > t0 + 1e-6 && t <= t1 + 1e-6);
    out.push({
      time: (t0 + t1) / 2,
      speed: isJump || t1 <= t0 ? null : distanceBetween(s.values[i], s.values[i + 1]) / (t1 - t0)
    });
  }
  return out;
}
function segmentProfile(startSpeed, endSpeed, peak, hold) {
  if (hold) return "hold";
  if (peak < 1e-6) return "static";
  const s = startSpeed / peak;
  const e = endSpeed / peak;
  if (s > 0.8 && e > 0.8) return "constant";
  if (s < 0.5 && e < 0.5) return "ease in-out";
  if (s < 0.5 && e > 0.8) return "speeds up";
  if (s > 0.8 && e < 0.5) return "slows down";
  return "uneven";
}
var r3 = (x) => Math.round(x * 1e3) / 1e3;
function analyzeMotion(s, speeds) {
  const dims = s.values[0]?.length ?? 0;
  const min = [];
  const max = [];
  for (let d = 0; d < dims; d++) {
    min.push(Math.min(...s.values.map((v) => v[d])));
    max.push(Math.max(...s.values.map((v) => v[d])));
  }
  let peak = 0;
  let peakTime = null;
  let distance = 0;
  let movingTime = 0;
  speeds.forEach((sp, i) => {
    if (sp.speed === null) return;
    const dt = s.times[i + 1] - s.times[i];
    distance += sp.speed * dt;
    movingTime += dt;
    if (sp.speed > peak) {
      peak = sp.speed;
      peakTime = sp.time;
    }
  });
  const overshoot = [];
  if (s.keys.length >= 2) {
    for (let d = 0; d < dims; d++) {
      const keyMin = Math.min(...s.keys.map((k) => k.value[d]));
      const keyMax = Math.max(...s.keys.map((k) => k.value[d]));
      const tol = Math.max(1e-3, (keyMax - keyMin) * 1e-3);
      const below = keyMin - min[d] > tol ? keyMin - min[d] : 0;
      const above = max[d] - keyMax > tol ? max[d] - keyMax : 0;
      if (below > 0 || above > 0) {
        overshoot.push({ dimension: d, below_keys_by: r3(below), above_keys_by: r3(above) });
      }
    }
  }
  const segments = [];
  for (let k = 0; k + 1 < s.keys.length; k++) {
    const a = s.keys[k];
    const b = s.keys[k + 1];
    const inside = [];
    speeds.forEach((sp, i) => {
      if (sp.speed === null || s.times[i] < a.time - 1e-6 || s.times[i + 1] > b.time + 1e-6) return;
      inside.push({ speed: sp.speed, time: sp.time, dt: s.times[i + 1] - s.times[i] });
    });
    if (inside.length === 0) continue;
    let segPeak = inside[0];
    for (const p of inside) if (p.speed > segPeak.speed) segPeak = p;
    const startSpeed = inside[0].speed;
    const endSpeed = inside[inside.length - 1].speed;
    segments.push({
      from_key: a.index,
      to_key: b.index,
      start: r3(a.time),
      end: r3(b.time),
      distance: r3(inside.reduce((sum, p) => sum + p.speed * p.dt, 0)),
      start_speed: r3(startSpeed),
      end_speed: r3(endSpeed),
      peak_speed: r3(segPeak.speed),
      peak_at: segPeak.speed < 1e-6 ? null : Math.round((segPeak.time - a.time) / (b.time - a.time) * 100) / 100,
      profile: segmentProfile(startSpeed, endSpeed, segPeak.speed, a.out_interp === "hold")
    });
  }
  return {
    speed: { peak: r3(peak), peak_time: peakTime === null ? null : r3(peakTime), mean: movingTime > 0 ? r3(distance / movingTime) : 0 },
    distance: r3(distance),
    value: {
      start: (s.values[0] ?? []).map(r3),
      end: (s.values[s.values.length - 1] ?? []).map(r3),
      min: min.map(r3),
      max: max.map(r3)
    },
    overshoot,
    segments
  };
}
function formatNumber(v) {
  const a = Math.abs(v);
  if (a >= 1e3) return v.toFixed(0);
  if (a >= 100) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  return v.toFixed(3);
}
function renderMotionGraph(s, speeds, width, height) {
  const scale = height >= 300 ? 2 : 1;
  const glyphH = GLYPH_HEIGHT * scale;
  const dims = s.values[0]?.length ?? 0;
  let vmin = Infinity;
  let vmax = -Infinity;
  for (const v of s.values) {
    for (const x of v) {
      vmin = Math.min(vmin, x);
      vmax = Math.max(vmax, x);
    }
  }
  if (!Number.isFinite(vmin)) {
    vmin = 0;
    vmax = 1;
  } else if (vmax - vmin < 1e-9) {
    const pad = Math.max(1, Math.abs(vmin) * 0.1);
    vmin -= pad;
    vmax += pad;
  }
  let peak = 0;
  for (const sp of speeds) if (sp.speed !== null && sp.speed > peak) peak = sp.speed;
  const speedMax = peak > 0 ? peak : 1;
  const yLabels = [formatNumber(vmax), formatNumber(vmin), formatNumber(speedMax), "0"];
  const left = Math.max(...yLabels.map((l) => textWidth(l, scale))) + 4 * scale + 6;
  const right = 4 * scale + 6;
  const top = glyphH + 8;
  const bottom = glyphH + 8;
  const gap = glyphH + 8;
  const plotW = Math.max(1, width - left - right);
  const plotH = Math.max(1, Math.floor((height - top - bottom - gap) / 2));
  const valueTop = top;
  const speedTop = top + plotH + gap;
  const span = s.end - s.start > 0 ? s.end - s.start : 1;
  const xOf = (t) => left + Math.round((t - s.start) / span * (plotW - 1));
  const yValue = (v) => valueTop + Math.round((1 - (v - vmin) / (vmax - vmin)) * (plotH - 1));
  const ySpeed = (v) => speedTop + Math.round((1 - v / speedMax) * (plotH - 1));
  const img = createCanvas(width, height, SHEET_BG);
  for (const panelTop of [valueTop, speedTop]) {
    fillRect(img, left, panelTop, plotW, plotH, PANEL_BG);
    fillRect(img, left, panelTop + Math.floor(plotH / 2), plotW, 1, GRID_COLOUR);
  }
  const keysInRange = s.keys.filter((k) => k.time >= s.start - 1e-6 && k.time <= s.end + 1e-6);
  let labelRight = -Infinity;
  for (const k of keysInRange) {
    const x = xOf(k.time);
    fillRect(img, x, valueTop, 1, speedTop + plotH - valueTop, KEY_LINE);
    const label = `#${k.index}`;
    const w = textWidth(label, scale);
    const lx = Math.min(Math.max(0, x - Math.floor(w / 2)), width - w);
    if (lx > labelRight + 2 * scale) {
      drawText(img, label, lx, top - glyphH - 4, scale, KEY_COLOUR);
      labelRight = lx + w;
    }
  }
  for (let d = 0; d < dims; d++) {
    const colour = DIM_COLOURS[d % DIM_COLOURS.length];
    for (let i = 0; i + 1 < s.times.length; i++) {
      drawLine(img, xOf(s.times[i]), yValue(s.values[i][d]), xOf(s.times[i + 1]), yValue(s.values[i + 1][d]), 2, colour);
    }
  }
  for (const k of keysInRange) {
    for (let d = 0; d < Math.min(dims, k.value.length); d++) {
      fillRect(img, xOf(k.time) - 2, yValue(k.value[d]) - 2, 5, 5, KEY_COLOUR);
    }
  }
  for (let i = 0; i < speeds.length; i++) {
    const sp = speeds[i].speed;
    if (sp === null) continue;
    const next = speeds[i + 1]?.speed ?? null;
    const prev = speeds[i - 1]?.speed ?? null;
    if (next !== null) {
      drawLine(img, xOf(speeds[i].time), ySpeed(sp), xOf(speeds[i + 1].time), ySpeed(next), 2, SPEED_COLOUR);
    } else if (prev === null) {
      drawLine(img, xOf(s.times[i]), ySpeed(sp), xOf(s.times[i + 1]), ySpeed(sp), 2, SPEED_COLOUR);
    }
  }
  const rightAlign = (text, x, y) => drawText(img, text, x - textWidth(text, scale), y, scale, AXIS_LABEL);
  rightAlign(yLabels[0], left - 6, valueTop);
  rightAlign(yLabels[1], left - 6, valueTop + plotH - glyphH);
  rightAlign(yLabels[2], left - 6, speedTop);
  rightAlign(yLabels[3], left - 6, speedTop + plotH - glyphH);
  drawText(img, `${s.start.toFixed(2)}s`, left, height - bottom + 4, scale, AXIS_LABEL);
  rightAlign(`${s.end.toFixed(2)}s`, left + plotW, height - bottom + 4);
  return img;
}
var MOTION_MATCH_NAMES = /* @__PURE__ */ new Set([
  "ADBE Position",
  "ADBE Position_0",
  "ADBE Position_1",
  "ADBE Position_2",
  "ADBE Anchor Point",
  "ADBE Scale",
  "ADBE Rotate Z",
  "ADBE Rotate X",
  "ADBE Rotate Y",
  "ADBE Orientation"
]);
var SEVERITY_ORDER = { medium: 0, low: 1, info: 2 };
var isMoving = (g) => g.profile !== "hold" && g.profile !== "static";
function fixEase(taste) {
  const c = taste?.preferred_ease;
  if (!c || c.length !== 4) return { ease: "easy_ease", name: "Easy ease" };
  const influence = (v) => Math.min(100, Math.max(0.1, Math.round(v * 1e3) / 10));
  return {
    ease: { in: { speed: 0, influence: influence(1 - c[2]) }, out: { speed: 0, influence: influence(c[0]) } },
    name: "Your preferred ease"
  };
}
function reviewProperty(s, analysis, speeds, path23, target, taste) {
  const findings = [];
  const motion = MOTION_MATCH_NAMES.has(s.property.matchName);
  const timingOk = !motion && taste?.allow_linear_non_motion === true;
  const unit = s.property.spatial ? "px/s" : "/s";
  const base = {
    layer: s.layer,
    property: { name: s.property.name, path: path23 }
  };
  const { ease: easeArg, name: easeName } = fixEase(taste);
  const fix = (keys) => ({
    tool: "ae_set_keyframe_ease",
    args: {
      comp_id: target.comp_id,
      layer: { id: s.layer.id },
      path: path23,
      keys,
      ease: easeArg,
      expect: { project_path: target.project_path, comp_id: target.comp_id }
    }
  });
  const segs = analysis.segments;
  const propPeak = analysis.speed.peak;
  const keepsMovingAfter = (time, speed) => {
    const next = speeds.find((sp) => sp.time > time + 1e-6 && sp.speed !== null);
    return next !== void 0 && next.speed > 0.3 * speed;
  };
  for (let i = 0; i < segs.length; i++) {
    if (timingOk || segs[i].profile !== "constant") continue;
    let j = i;
    while (j + 1 < segs.length && segs[j + 1].profile === "constant" && Math.min(segs[j].peak_speed, segs[j + 1].peak_speed) / Math.max(segs[j].peak_speed, segs[j + 1].peak_speed) > 0.75) {
      j++;
    }
    const from = segs[i].from_key;
    const to = segs[j].to_key;
    const middle = j > i ? ` The key${j - i > 1 ? "s" : ""} in between keep${j - i > 1 ? "" : "s"} its linear speed, which leaves a slight dip there; making ${j - i > 1 ? "them" : "it"} roving in AE (Keyframe > Rove Across Time) gives one smooth curve.` : "";
    findings.push({
      ...base,
      severity: motion ? "medium" : "low",
      kind: "linear",
      keys: [from, to],
      time: segs[i].start,
      message: `${s.property.name} runs at one constant speed (${formatNumber(segs[i].peak_speed)} ${unit}) from key ${from} to key ${to} (${segs[i].start}s to ${segs[j].end}s), so it starts and stops abruptly and reads as mechanical. ${easeName} on keys ${from} and ${to} softens both ends.${middle}`,
      fix: fix([from, to])
    });
    i = j;
  }
  for (let i = 0; i < segs.length; i++) {
    const g = segs[i];
    if (timingOk || !isMoving(g) || g.profile === "constant" || g.peak_speed <= 0) continue;
    const startsHere = i === 0 || !isMoving(segs[i - 1]) || segs[i - 1].to_key !== g.from_key;
    const endsHere = i === segs.length - 1 || !isMoving(segs[i + 1]) || segs[i + 1].from_key !== g.to_key;
    if (startsHere && g.start_speed / g.peak_speed > 0.5) {
      findings.push({
        ...base,
        severity: motion ? "medium" : "low",
        kind: "abrupt_start",
        keys: [g.from_key],
        time: g.start,
        message: `${s.property.name} starts moving at ${Math.round(g.start_speed / g.peak_speed * 100)}% of its top speed at key ${g.from_key} (${g.start}s), with no acceleration. ${easeName} on key ${g.from_key} eases it in.`,
        fix: fix([g.from_key])
      });
    }
    if (endsHere && g.end_speed / g.peak_speed > 0.5 && !keepsMovingAfter(g.end, g.end_speed)) {
      findings.push({
        ...base,
        severity: motion ? "medium" : "low",
        kind: "abrupt_stop",
        keys: [g.to_key],
        time: g.end,
        message: `${s.property.name} stops dead at key ${g.to_key} (${g.end}s), arriving at ${Math.round(g.end_speed / g.peak_speed * 100)}% of its top speed. ${easeName} on key ${g.to_key} lets it settle.`,
        fix: fix([g.to_key])
      });
    }
  }
  for (let i = 0; i + 1 < segs.length; i++) {
    const a = segs[i];
    const b = segs[i + 1];
    if (!isMoving(a) || !isMoving(b) || a.to_key !== b.from_key) continue;
    const hi = Math.max(a.end_speed, b.start_speed);
    const lo = Math.min(a.end_speed, b.start_speed);
    if (hi < 0.25 * propPeak || lo > 0.3 * hi) continue;
    const nearlyStopped = lo < 0.1 * hi;
    findings.push({
      ...base,
      severity: "medium",
      kind: "speed_jump",
      keys: [a.to_key],
      time: a.end,
      message: `${s.property.name} changes speed abruptly at key ${a.to_key} (${a.end}s): ${formatNumber(a.end_speed)} ${unit} in, ${formatNumber(b.start_speed)} ${unit} out.` + (nearlyStopped ? ` ${easeName} on key ${a.to_key} smooths the hand-over.` : " Match the speeds on both sides of the key (in the graph editor, or with an explicit ease)."),
      ...nearlyStopped ? { fix: fix([a.to_key]) } : {}
    });
  }
  for (const o of analysis.overshoot) {
    const d = o.dimension;
    const past = o.above_keys_by >= o.below_keys_by;
    let at = 0;
    for (let i = 1; i < s.values.length; i++) {
      if (past ? s.values[i][d] > s.values[at][d] : s.values[i][d] < s.values[at][d]) at = i;
    }
    const unwanted = taste?.avoid_overshoot === true;
    findings.push({
      ...base,
      severity: unwanted ? "low" : "info",
      kind: "overshoot",
      keys: [],
      time: r3(s.times[at]),
      message: `${s.property.name}${s.values[0].length > 1 ? ` (dimension ${d})` : ""} goes ${formatNumber(Math.max(o.above_keys_by, o.below_keys_by))} past its keyframe values around ${r3(s.times[at])}s. ` + (unwanted ? "The user prefers no overshoot." : "Fine for a bounce or settle; a mistake otherwise.")
    });
  }
  const fps = s.comp.fps > 0 ? s.comp.fps : 25;
  const offGrid = s.keys.map((k) => ({ index: k.index, time: k.time, frame: k.time * fps })).filter((k) => Math.abs(k.frame - Math.round(k.frame)) > 0.01);
  if (offGrid.length > 0) {
    const list = (items) => items.length === 1 ? items[0] : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
    const many = offGrid.length > 1;
    findings.push({
      ...base,
      severity: "low",
      kind: "subframe_key",
      keys: offGrid.map((k) => k.index),
      time: r3(offGrid[0].time),
      message: `${many ? "Keys" : "Key"} ${list(offGrid.map((k) => String(k.index)))} of ${s.property.name} ${many ? "sit" : "sits"} between frames (frame ${list(offGrid.map((k) => formatNumber(k.frame)))}), so no rendered frame lands on ${many ? "them" : "it"}. Move ${many ? "them" : "it"} to frame ${list(offGrid.map((k) => String(Math.round(k.frame))))}.`
    });
  }
  return findings;
}
function sortFindings(findings) {
  return [...findings].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.layer.index - b.layer.index || a.time - b.time
  );
}
var AeMotionReviewSchema = external_exports.object({
  comp_id: external_exports.number().int().describe("CompItem ID to review."),
  layers: external_exports.array(LayerSelectorSchema).max(50).optional().describe("Only review these layers. Default: every layer in the comp."),
  include_info: external_exports.boolean().optional().describe("Include info findings (overshoot past keyframe values). Default true."),
  max_findings: external_exports.number().int().min(1).max(200).optional().describe("Return at most this many findings, most severe first (default 50).")
});
async function runQueued(ctx, label, opId, fn) {
  try {
    return await ctx.queue.run(label, fn);
  } catch (err) {
    if (err instanceof QueueWaitError) {
      throw new BridgeError({ kind: "queued", op_id: opId, message: err.message });
    }
    throw err;
  }
}
var motionTools = [
  {
    name: "ae_contact_sheet",
    description: "READ-ONLY. Shows how a comp moves over time in ONE image: samples 2 to 24 frames (default 12, evenly across the work area, or a `start`/`end` range, or explicit `times`), renders each at full resolution with saveFrameToPng, shrinks them on the server and tiles them into a single PNG with frame/time labels. Transparency shows as a checkerboard; blank, black or fully transparent frames get a red border and are listed in `flagged_frames`. Look at the returned `path` to judge timing, spacing and composition across the shot; each tile's full-resolution PNG is in `frames[].path`. Every frame is a render, so heavy comps take a while: start with fewer frames. The comp is never modified. " + AGENT_SAFETY_GUIDANCE,
    schema: AeContactSheetSchema,
    handler: async (args, ctx) => {
      const framesDir = defaultFramesDir();
      fs18.mkdirSync(framesDir, { recursive: true });
      const opId = ctx.bridge.newOpId();
      const captured = await runQueued(ctx, `ae_contact_sheet(${args.comp_id})`, opId, async () => {
        const compResp = await ctx.bridge.evalRaw({
          id: `${opId}_comp`,
          script: buildJsxCall("getComp", { comp_id: args.comp_id }),
          label: `ae_contact_sheet(${args.comp_id}) getComp`,
          mutates: false,
          toolName: "ae_contact_sheet"
        });
        const comp2 = compResp.result;
        const samples = contactSheetTimes(
          {
            fps: Number(comp2.fps),
            duration: Number(comp2.duration),
            workAreaStart: Number(comp2.workAreaStart),
            workAreaDuration: Number(comp2.workAreaDuration)
          },
          args
        );
        const shots2 = [];
        for (let i = 0; i < samples.length; i++) {
          const snap = await captureCompFrame({
            ctx,
            opId,
            compId: args.comp_id,
            time: samples[i].time,
            frameIndex: i,
            framesDir,
            toolName: "ae_contact_sheet"
          });
          shots2.push({ ...samples[i], path: snap.path });
        }
        return { comp: comp2, shots: shots2 };
      });
      const { comp, shots } = captured;
      const showLabels = args.labels ?? true;
      const layout = sheetLayout(
        shots.length,
        Number(comp.width),
        Number(comp.height),
        args.tile_size ?? 320,
        args.columns,
        showLabels
      );
      const tiles = [];
      const frames = [];
      shots.forEach((shot, index) => {
        const full = decodePngFile(shot.path);
        const analysis = analyzeDecodedFrame(full, { index, path: shot.path, time: shot.time });
        tiles.push({
          image: resizeArea(full, layout.tileWidth, layout.tileHeight),
          label: showLabels ? frameLabel(shot) : void 0,
          flagged: analysis.flags.length > 0
        });
        frames.push({ index, frame: shot.frame, time: shot.time, path: shot.path, flags: analysis.flags });
      });
      const sheet = buildContactSheet(tiles, layout);
      const sheetPath = path18.join(
        framesDir,
        `contact_c${args.comp_id}_${Date.now()}_${crypto4.randomBytes(4).toString("hex")}.png`
      );
      fs18.writeFileSync(sheetPath, encodePng(sheet));
      return {
        ok: true,
        path: sheetPath,
        width: layout.width,
        height: layout.height,
        columns: layout.columns,
        rows: layout.rows,
        tile_width: layout.tileWidth,
        tile_height: layout.tileHeight,
        comp: {
          id: comp.id,
          name: comp.name,
          width: comp.width,
          height: comp.height,
          fps: comp.fps,
          duration: comp.duration
        },
        frames,
        flagged_frames: frames.filter((f) => f.flags.length > 0).map((f) => ({ index: f.index, time: f.time, flags: f.flags }))
      };
    }
  },
  {
    name: "ae_motion_graph",
    description: "READ-ONLY. Graphs how one property changes over time, like AE's graph editor, in one PNG: the value per dimension on top (red, green, blue for X, Y, Z), the speed underneath, and keyframes as yellow lines labelled #1, #2... The property is sampled with expressions applied (one sample per frame by default, at most 1000), so the graph shows what the viewer sees. Also returns the numbers: peak and mean speed, the value range, `overshoot` past the keyframe values, and per pair of keyframes a `segments[].profile` (constant, ease in-out, speeds up, slows down, hold, static, uneven). Use it to check easing and timing, or to compare before and after an ease change. Speed is the change across all dimensions per second (px/s for position). The comp is never modified, not even its current time. " + AGENT_SAFETY_GUIDANCE,
    schema: AeMotionGraphSchema,
    handler: async (args, ctx) => {
      const res = await ctx.bridge.callHost(
        "sampleProperty",
        {
          comp_id: args.comp_id,
          layer: args.layer,
          path: args.path,
          start: args.start,
          end: args.end,
          step: args.step
        },
        { label: `ae_motion_graph(${args.comp_id})`, mutates: false, toolName: "ae_motion_graph" }
      );
      const samples = res.result;
      const speeds = sampleSpeeds(samples);
      const analysis = analyzeMotion(samples, speeds);
      const width = args.width ?? 960;
      const height = args.height ?? 540;
      const framesDir = defaultFramesDir();
      fs18.mkdirSync(framesDir, { recursive: true });
      const graphPath = path18.join(
        framesDir,
        `graph_c${args.comp_id}_${Date.now()}_${crypto4.randomBytes(4).toString("hex")}.png`
      );
      fs18.writeFileSync(graphPath, encodePng(renderMotionGraph(samples, speeds, width, height)));
      return {
        ok: true,
        path: graphPath,
        width,
        height,
        comp: samples.comp,
        layer: samples.layer,
        property: samples.property,
        start: r3(samples.start),
        end: r3(samples.end),
        step: Math.round(samples.step * 1e6) / 1e6,
        samples: samples.times.length,
        speed: { unit: samples.property.spatial ? "px/s" : "units/s", ...analysis.speed },
        distance: analysis.distance,
        value: analysis.value,
        overshoot: analysis.overshoot,
        segments: analysis.segments,
        keys: samples.keys.map((k) => ({ ...k, time: r3(k.time), value: k.value.map(r3) })),
        ...args.include_samples ? {
          // speed_after: speed from this sample to the next (null at the last sample and across a hold jump).
          sample_table: samples.times.map((t, i) => ({
            time: r3(t),
            value: samples.values[i].map(r3),
            speed_after: i < speeds.length && speeds[i].speed !== null ? r3(speeds[i].speed) : null
          }))
        } : {}
      };
    }
  },
  {
    name: "ae_motion_review",
    description: "READ-ONLY. Reviews a comp's animation the way an animator would, and lists what to fix. Every keyframed property (up to 200) is sampled once per frame with expressions applied, and checked for: constant-speed (linear) moves; motion that starts or stops at full speed; abrupt speed changes at a key; overshoot past the keyframe values (info: fine for a bounce); keys that sit between frames. Findings are sorted most severe first. Medium means motion properties (position, scale, rotation); linear opacity or effect keys are low, since they are often deliberate. Each finding names the layer, property, keys and time. Most carry `fix`: a ready ae_set_keyframe_ease call with easy_ease, or with the handle lengths of the user's preferred ease when ae_taste has one. The review also follows ae_taste on linear opacity and effect timing and on overshoot; `taste` in the result shows what applied. Show the findings to the user and apply fixes only once they agree, then run ae_motion_review again to confirm. ae_motion_graph shows any one property in detail. The comp is never modified. " + AGENT_SAFETY_GUIDANCE,
    schema: AeMotionReviewSchema,
    handler: async (args, ctx) => {
      const opId = ctx.bridge.newOpId();
      const label = `ae_motion_review(${args.comp_id})`;
      const scanned = await runQueued(ctx, label, opId, async () => {
        const listResp = await ctx.bridge.evalRaw({
          id: `${opId}_list`,
          script: buildJsxCall("listAnimatedProperties", { comp_id: args.comp_id, layers: args.layers }),
          label: `${label} list`,
          mutates: false,
          toolName: "ae_motion_review"
        });
        const list = listResp.result;
        const workAreaEnd = Number(list.comp.workAreaStart) + Number(list.comp.workAreaDuration);
        const sampled = [];
        for (let i = 0; i < list.properties.length; i++) {
          const p = list.properties[i];
          const end = p.expression && workAreaEnd > p.last_key_time + 1e-6 ? workAreaEnd : void 0;
          const resp = await ctx.bridge.evalRaw({
            id: `${opId}_p${i}`,
            script: buildJsxCall("sampleProperty", { comp_id: args.comp_id, layer: { id: p.layer.id }, path: p.path, end }),
            label: `${label} ${p.layer.name} > ${p.name}`,
            mutates: false,
            toolName: "ae_motion_review"
          });
          sampled.push({ path: p.path, samples: resp.result });
        }
        return { list, sampled };
      });
      const target = { comp_id: args.comp_id, project_path: scanned.list.project_path };
      const taste = ctx.settings?.get().taste;
      let findings = [];
      for (const { path: propPath, samples } of scanned.sampled) {
        const speeds = sampleSpeeds(samples);
        findings.push(...reviewProperty(samples, analyzeMotion(samples, speeds), speeds, propPath, target, taste));
      }
      if (args.include_info === false) findings = findings.filter((f) => f.severity !== "info");
      findings = sortFindings(findings);
      const counts = { medium: 0, low: 0, info: 0 };
      const byKind = {};
      for (const f of findings) {
        counts[f.severity]++;
        byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
      }
      const max = args.max_findings ?? 50;
      return {
        ok: true,
        comp: scanned.list.comp,
        project_path: scanned.list.project_path,
        layers_scanned: scanned.list.layers_scanned,
        properties_scanned: scanned.sampled.length,
        properties_truncated: scanned.list.truncated,
        clean: counts.medium === 0 && counts.low === 0,
        counts,
        by_kind: byKind,
        findings: findings.slice(0, max),
        findings_truncated: findings.length > max,
        ...taste && (taste.preferred_ease || taste.allow_linear_non_motion || taste.avoid_overshoot) ? {
          taste: {
            preferred_ease: taste.preferred_ease,
            allow_linear_non_motion: taste.allow_linear_non_motion,
            avoid_overshoot: taste.avoid_overshoot
          }
        } : {}
      };
    }
  }
];

// src/tools/ext/panels.ts
var import_node_child_process2 = require("node:child_process");
var fs19 = __toESM(require("node:fs"), 1);
var path19 = __toESM(require("node:path"), 1);
var CURATED_NATIVE_PANELS = [
  "Align",
  "Audio",
  "Brushes",
  "Character",
  "Content-Aware Fill",
  "Effects & Presets",
  "Essential Graphics",
  "Essential Properties",
  "Info",
  "Learn",
  "Libraries",
  "Lumetri Scopes",
  "Mask Interpolation",
  "Media Browser",
  "Motion Sketch",
  "Paint",
  "Paragraph",
  "Preview",
  "Progress",
  "Properties",
  "Smoother",
  "Tracker",
  "Wiggler"
];
var runtimeOverrides2 = {};
function currentPlatform2() {
  return runtimeOverrides2.platform ?? process.platform;
}
function defaultUiDir() {
  if (runtimeOverrides2.uiDir) {
    return runtimeOverrides2.uiDir;
  }
  return path19.join(defaultDataDir(), "ui");
}
function runPowerShellScript2(ps1Args) {
  if (runtimeOverrides2.ps1Runner) {
    return runtimeOverrides2.ps1Runner(ps1Args);
  }
  const scriptPath = runtimeOverrides2.scriptPath !== void 0 ? runtimeOverrides2.scriptPath : locateDialogsPs1Script();
  if (!scriptPath) {
    return Promise.resolve(
      JSON.stringify({
        ok: false,
        error: "ae_dialogs_ps1_not_found"
      })
    );
  }
  const fullArgs = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    ...ps1Args
  ];
  return new Promise((resolve2) => {
    (0, import_node_child_process2.execFile)(
      "powershell.exe",
      fullArgs,
      {
        windowsHide: true,
        timeout: 15e3,
        maxBuffer: 4 * 1024 * 1024
      },
      (err, stdout, stderr) => {
        const outStr = typeof stdout === "string" ? stdout.trim() : "";
        if (outStr.length > 0) {
          resolve2(outStr);
          return;
        }
        const errMsg = err instanceof Error ? err.message : typeof stderr === "string" && stderr.trim().length > 0 ? stderr.trim() : "powershell_exec_failed";
        resolve2(
          JSON.stringify({
            ok: false,
            error: errMsg
          })
        );
      }
    );
  });
}
var AeListPanelsSchema = external_exports.object({
  filter: external_exports.string().optional().describe(
    "Optional filter: 'native' for native panels only, 'extensions' for CEP extensions only, or a search substring matching panel names or IDs."
  )
});
var AeOpenPanelSchema = external_exports.object({
  name: external_exports.string().min(1).optional().describe(
    "Native After Effects panel name from the Window menu (e.g. 'Effects & Presets', 'Align', 'Character'). NOTE: Window menu commands toggle the panel (open if closed, close if open) and scripting cannot query their open state. Opening a native panel requires allow_toggle: true after visually verifying via ae_ui_screenshot that the panel is currently closed."
  ),
  extension_id: external_exports.string().min(1).optional().describe(
    "ID of a CEP extension to open (e.g. 'london.chroma.aemcp.panel'). Opening a CEP extension never toggles."
  ),
  allow_toggle: external_exports.boolean().default(false).optional().describe(
    "Must be set to true to execute native Window menu panel commands. Because Window menu commands toggle (they close the panel if it is already open) and scripting cannot detect panel state, you must first take a screenshot with ae_ui_screenshot to verify the panel is closed before passing allow_toggle: true."
  )
}).refine((val) => Boolean(val.name || val.extension_id), {
  message: "Must specify either 'name' (for a native panel) or 'extension_id' (for a CEP extension)."
});
var AeUiScreenshotSchema = external_exports.object({});
var panelsTools = [
  {
    name: "ae_list_panels",
    description: "READ-ONLY. Lists installed CEP extensions and native After Effects Window-menu panels with their ExtendScript command IDs (cmdId). Note: Native Window-menu commands toggle and their open/closed state cannot be queried via scripting; use ae_ui_screenshot to verify visibility. " + AGENT_SAFETY_GUIDANCE,
    schema: AeListPanelsSchema,
    handler: async (args, ctx) => {
      if (!ctx.cep) {
        return { ok: false, error: "cep_unavailable" };
      }
      const rawExts = await ctx.cep.listExtensions();
      const allExts = (Array.isArray(rawExts) ? rawExts : []).filter(
        (ext2) => ext2 && ext2.id && ext2.id !== "london.chroma.aemcp.service"
      ).map((ext2) => ({
        id: ext2.id,
        name: ext2.name || ext2.id
      }));
      const jsxScript = "(function(){\nvar names=" + JSON.stringify(CURATED_NATIVE_PANELS) + ";\nvar out=[];\nfor(var i=0;i<names.length;i++){\nvar id=app.findMenuCommandId(names[i]);\nif(id!==0){\nout.push({name:names[i],cmdId:id});\n}\n}\nreturn out;\n})()";
      const nativeRes = await ctx.bridge.evalRaw({
        id: ctx.bridge.newOpId(),
        script: jsxScript,
        label: "ae_list_panels(native)",
        mutates: false,
        toolName: "ae_list_panels"
      });
      const allNative = Array.isArray(nativeRes.result) ? nativeRes.result : [];
      const filter = typeof args.filter === "string" ? args.filter.trim() : "";
      if (filter.length > 0) {
        const lowerFilter = filter.toLowerCase();
        if (lowerFilter === "native") {
          return {
            ok: true,
            extensions: [],
            native: allNative
          };
        }
        if (lowerFilter === "extensions" || lowerFilter === "extension") {
          return {
            ok: true,
            extensions: allExts,
            native: []
          };
        }
        return {
          ok: true,
          extensions: allExts.filter(
            (e) => e.name.toLowerCase().includes(lowerFilter) || e.id.toLowerCase().includes(lowerFilter)
          ),
          native: allNative.filter(
            (n) => n.name.toLowerCase().includes(lowerFilter)
          )
        };
      }
      return {
        ok: true,
        extensions: allExts,
        native: allNative
      };
    }
  },
  {
    name: "ae_open_panel",
    description: "Opens an After Effects CEP extension or native Window-menu panel. CEP extensions (via extension_id) open directly and never toggle. IMPORTANT: Native Window-menu commands (via name) toggle (calling them when already open will close the panel). To prevent accidental closure, opening a native panel without allow_toggle: true is refused. First use ae_ui_screenshot to verify the panel is closed, then pass allow_toggle: true. " + AGENT_SAFETY_GUIDANCE,
    schema: AeOpenPanelSchema,
    handler: async (args, ctx) => {
      if (args.extension_id) {
        if (!ctx.cep) {
          return { ok: false, error: "cep_unavailable" };
        }
        const opened = await ctx.cep.openExtension(args.extension_id);
        return {
          ok: true,
          extension_id: args.extension_id,
          opened: Boolean(opened)
        };
      }
      if (args.name) {
        if (args.allow_toggle !== true) {
          return {
            ok: false,
            error: "refused_toggle_risk",
            message: `Refused to execute Window menu command for "${args.name}": Window-menu commands toggle After Effects panels and scripting cannot query whether the panel is currently open or closed. Executing this command when the panel is already open will close it. First use ae_ui_screenshot to verify that "${args.name}" is closed, then call ae_open_panel with allow_toggle: true.`
          };
        }
        const jsxScript = "(function(){\nvar cmdId=app.findMenuCommandId(" + JSON.stringify(args.name) + ");\nif(!cmdId||cmdId===0){\nreturn {ok:false,error:'unknown_menu_command'};\n}\napp.executeCommand(cmdId);\nreturn {ok:true,cmdId:cmdId};\n})()";
        const res = await ctx.bridge.evalRaw({
          id: ctx.bridge.newOpId(),
          script: jsxScript,
          label: `ae_open_panel(${args.name})`,
          mutates: false,
          toolName: "ae_open_panel"
        });
        if (!res.result || !res.result.ok) {
          return {
            ok: false,
            error: res.result?.error || "command_failed",
            name: args.name,
            message: `Menu command "${args.name}" was not recognized by After Effects (findMenuCommandId returned 0).`
          };
        }
        return {
          ok: true,
          cmdId: res.result.cmdId,
          executed: true,
          note: "Window commands toggle; verify with ae_ui_screenshot"
        };
      }
      return {
        ok: false,
        error: "invalid_arguments",
        message: "Must specify either 'name' (for a native panel) or 'extension_id' (for a CEP extension)."
      };
    }
  },
  {
    name: "ae_ui_screenshot",
    description: "READ-ONLY. Captures a PNG screenshot of After Effects' main window (window class AE_CApplication_*) via Win32 PrintWindow into %LOCALAPPDATA%/chroma-ae-mcp/ui/ without bringing the window to the foreground or activating it. Returns { ok: true, path, width, height }. Use this to visually verify panel open/closed visibility because native Window-menu commands toggle and their state cannot be read via scripting. When AE is minimized it returns `error: 'ae_minimized'` instead of an image: ask the user to restore the window (this tool never does). " + AGENT_SAFETY_GUIDANCE,
    schema: AeUiScreenshotSchema,
    handler: async () => {
      const platform = currentPlatform2();
      if (platform !== "win32") {
        return {
          ok: false,
          error: "not_implemented_on_this_os"
        };
      }
      const outDir = defaultUiDir();
      try {
        fs19.mkdirSync(outDir, { recursive: true });
      } catch {
      }
      const rawStdout = await runPowerShellScript2([
        "-Mode",
        "screenshot-main",
        "-OutDir",
        outDir
      ]);
      const parsed = parsePs1JsonOutput(rawStdout);
      if (!parsed.ok) {
        if (parsed.error === "ae_minimized") {
          return {
            ok: false,
            error: "ae_minimized",
            message: "After Effects is minimized, so Windows only draws its title bar. Ask the user to restore the AE window, then try again."
          };
        }
        return {
          ok: false,
          error: parsed.error || "screenshot_failed"
        };
      }
      return {
        ok: true,
        path: parsed.path,
        width: parsed.width,
        height: parsed.height
      };
    }
  }
];

// src/tools/ext/receipts.ts
var fs20 = __toESM(require("node:fs"), 1);
var path20 = __toESM(require("node:path"), 1);
var DIFF_EPSILON = 1e-5;
function valuesEqual(a, b) {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") {
    if (Number.isNaN(a) && Number.isNaN(b)) return true;
    return Math.abs(a - b) <= DIFF_EPSILON;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!valuesEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const aObj = a;
    const bObj = b;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);
    if (aKeys.length !== bKeys.length) return false;
    for (const k of aKeys) {
      if (!(k in bObj)) return false;
      if (!valuesEqual(aObj[k], bObj[k])) return false;
    }
    return true;
  }
  return false;
}
function collectLeafProperties(nodes, prefix, out) {
  if (!nodes) return;
  if (!Array.isArray(nodes)) {
    for (const [key, leaf] of Object.entries(nodes)) {
      const p = leaf.path ?? `${prefix}/${key}`;
      out.set(p, leaf);
    }
    return;
  }
  for (const node of nodes) {
    const seg = node.matchName || node.name || String(node.propertyIndex ?? "");
    const nodePath = node.path ?? `${prefix}/${seg}`;
    if (node.kind === "group" || "properties" in node && Array.isArray(node.properties)) {
      const grp = node;
      collectLeafProperties(grp.properties, nodePath, out);
    } else {
      out.set(nodePath, node);
    }
  }
}
var COMP_SCALAR_FIELDS = [
  "name",
  "width",
  "height",
  "pixelAspect",
  "fps",
  "duration",
  "workAreaStart",
  "workAreaDuration",
  "bgColor",
  "markers"
];
var LAYER_SCALAR_FIELDS = [
  "name",
  "index",
  "type",
  "inPoint",
  "outPoint",
  "startTime",
  "enabled",
  "locked",
  "label",
  "parent",
  "parentId",
  "solo",
  "threeDLayer",
  "blendingMode",
  "trackMatteType",
  "sourceId"
];
function diffFingerprints(before, after) {
  const changed = [];
  const added = [];
  const removed = [];
  for (const field of COMP_SCALAR_FIELDS) {
    const bVal = before[field];
    const aVal = after[field];
    if (bVal === void 0 && aVal === void 0) continue;
    if (!valuesEqual(bVal, aVal)) {
      changed.push({
        path: `comp.${String(field)}`,
        before: bVal,
        after: aVal
      });
    }
  }
  const beforeLayers = Array.isArray(before.layers) ? before.layers : [];
  const afterLayers = Array.isArray(after.layers) ? after.layers : [];
  const beforeById = /* @__PURE__ */ new Map();
  for (const l of beforeLayers) {
    beforeById.set(l.id, l);
  }
  const afterById = /* @__PURE__ */ new Map();
  for (const l of afterLayers) {
    afterById.set(l.id, l);
  }
  for (const bLayer of beforeLayers) {
    if (!afterById.has(bLayer.id)) {
      removed.push({
        path: `layer[${bLayer.id}]`,
        kind: "layer",
        id: bLayer.id,
        name: bLayer.name,
        index: bLayer.index,
        type: bLayer.type
      });
    }
  }
  for (const aLayer of afterLayers) {
    const bLayer = beforeById.get(aLayer.id);
    const layerPrefix = `layer[${aLayer.id}]`;
    if (!bLayer) {
      added.push({
        path: layerPrefix,
        kind: "layer",
        id: aLayer.id,
        name: aLayer.name,
        index: aLayer.index,
        type: aLayer.type
      });
      continue;
    }
    for (const field of LAYER_SCALAR_FIELDS) {
      const bVal = bLayer[field];
      const aVal = aLayer[field];
      if (bVal === void 0 && aVal === void 0) continue;
      if (!valuesEqual(bVal, aVal)) {
        changed.push({
          path: `${layerPrefix}.${String(field)}`,
          before: bVal,
          after: aVal
        });
      }
    }
    const bProps = /* @__PURE__ */ new Map();
    const aProps = /* @__PURE__ */ new Map();
    collectLeafProperties(bLayer.properties, layerPrefix, bProps);
    collectLeafProperties(aLayer.properties, layerPrefix, aProps);
    for (const [propPath, bProp] of bProps.entries()) {
      if (!aProps.has(propPath)) {
        removed.push({
          path: propPath,
          kind: "property",
          name: bProp.name,
          matchName: bProp.matchName,
          value: bProp.value
        });
      }
    }
    for (const [propPath, aProp] of aProps.entries()) {
      const bProp = bProps.get(propPath);
      if (!bProp) {
        added.push({
          path: propPath,
          kind: "property",
          name: aProp.name,
          matchName: aProp.matchName,
          value: aProp.value
        });
        continue;
      }
      if (!valuesEqual(bProp.value, aProp.value)) {
        changed.push({
          path: `${propPath}.value`,
          before: bProp.value,
          after: aProp.value
        });
      }
      const bNumKeys = bProp.numKeys ?? 0;
      const aNumKeys = aProp.numKeys ?? 0;
      if (bNumKeys !== aNumKeys) {
        changed.push({
          path: `${propPath}.numKeys`,
          before: bNumKeys,
          after: aNumKeys
        });
      }
      const bKeys = bProp.keyframes ?? [];
      const aKeys = aProp.keyframes ?? [];
      if (!valuesEqual(bKeys, aKeys)) {
        changed.push({
          path: `${propPath}.keyframes`,
          before: bKeys,
          after: aKeys
        });
      }
      const bExpr = bProp.expression ?? "";
      const aExpr = aProp.expression ?? "";
      if (bExpr !== aExpr) {
        changed.push({
          path: `${propPath}.expression`,
          before: bExpr,
          after: aExpr
        });
      }
      const bExprEnabled = Boolean(bProp.expressionEnabled);
      const aExprEnabled = Boolean(aProp.expressionEnabled);
      if (bExprEnabled !== aExprEnabled) {
        changed.push({
          path: `${propPath}.expressionEnabled`,
          before: bExprEnabled,
          after: aExprEnabled
        });
      }
    }
  }
  return { changed, added, removed };
}
var MAX_STORED_FINGERPRINTS = 20;
var fingerprintStore = /* @__PURE__ */ new Map();
var nextFingerprintSeq = 1;
function storeFingerprint(fp) {
  const id = `fp_${nextFingerprintSeq++}`;
  const entry = {
    id,
    comp_id: fp.comp_id,
    created_at: (/* @__PURE__ */ new Date()).toISOString(),
    fingerprint: fp
  };
  fingerprintStore.set(id, entry);
  while (fingerprintStore.size > MAX_STORED_FINGERPRINTS) {
    const oldestKey = fingerprintStore.keys().next().value;
    if (oldestKey === void 0) break;
    fingerprintStore.delete(oldestKey);
  }
  return entry;
}
function getStoredFingerprint(id) {
  return fingerprintStore.get(id);
}
function sanitizeCheckpointLabel(label) {
  const raw = (label ?? "checkpoint").trim();
  if (!raw) return "checkpoint";
  let cleaned = raw.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!cleaned) return "checkpoint";
  if (/^auto-/i.test(cleaned)) cleaned = `manual-${cleaned}`;
  return cleaned;
}
var AeCompFingerprintSchema = external_exports.object({
  comp_id: external_exports.number().int().describe("The CompItem ID to fingerprint.")
});
var AeCompDiffSchema = external_exports.object({
  before_id: external_exports.string().min(1).describe("The fingerprint ID previously returned by `ae_comp_fingerprint`."),
  comp_id: external_exports.number().int().optional().describe(
    "Target CompItem ID to fingerprint and compare against `before_id` (defaults to the comp_id stored on `before_id`)."
  )
});
var AeCheckpointCreateSchema = external_exports.object({
  expect: ExpectSchema,
  label: external_exports.string().min(1).max(80).optional().describe(
    "Optional label included in the checkpoint filename `<name>_<yyyyMMdd-HHmmss>_<label>.aep`."
  )
});
var AeCheckpointListSchema = external_exports.object({
  expect: ExpectSchema
});
var AeAutoCheckpointSchema = external_exports.object({
  enabled: external_exports.boolean().optional().describe("Turn automatic checkpoints on or off. Omit to leave unchanged."),
  max_mb: external_exports.number().positive().max(1e5).optional().describe("Skip projects whose .aep is larger than this many megabytes (default 250). Omit to leave unchanged.")
});
var AUTO_CHECKPOINT_TOOLS = [
  "ae_run_jsx",
  "ae_set_property",
  "ae_set_keyframe_ease",
  "ae_set_text",
  "ae_import_footage",
  "ae_replace_footage",
  "ae_render_queue_add",
  "ae_add_effect",
  "ae_set_effect",
  "ae_remove_effect",
  "ae_apply_preset",
  "ae_track_point",
  "ae_key_greenscreen",
  "ae_skill_run",
  "ae_build_from_data",
  "ae_reframe",
  "ae_import_assets"
];
var AeCheckpointRevertSchema = external_exports.object({
  expect: ExpectSchema,
  checkpoint_path: external_exports.string().min(1).describe("Absolute path to the `.aep` checkpoint file to open."),
  discard_changes: external_exports.boolean().optional().describe(
    "Must be true to close and revert when the currently open project has unsaved changes (`dirty: true`)."
  )
});
var receiptsTools = [
  {
    name: "ae_comp_fingerprint",
    description: "Read a deep, bounded fingerprint of a composition (every layer's settings and every property's value, numKeys, keyframe times/values, and expression, up to depth 6 and 5000 properties). Stores the fingerprint in server memory (retaining the 20 most recent) and returns its `id` and summary for use with `ae_comp_diff`. " + AGENT_SAFETY_GUIDANCE,
    schema: AeCompFingerprintSchema,
    handler: async (args, ctx) => {
      const res = await ctx.bridge.callHost(
        "compFingerprint",
        { comp_id: args.comp_id },
        {
          label: `ae_comp_fingerprint(${args.comp_id})`,
          mutates: false,
          toolName: "ae_comp_fingerprint"
        }
      );
      const fp = res.result;
      const entry = storeFingerprint(fp);
      const layers = Array.isArray(fp.layers) ? fp.layers : [];
      return {
        id: entry.id,
        comp_id: fp.comp_id,
        name: fp.name,
        created_at: entry.created_at,
        stored_count: fingerprintStore.size,
        summary: {
          comp_id: fp.comp_id,
          name: fp.name,
          width: fp.width,
          height: fp.height,
          fps: fp.fps,
          duration: fp.duration,
          numLayers: fp.numLayers ?? layers.length,
          layerCount: layers.length,
          propertyCount: fp.propertyCount ?? 0,
          truncated: Boolean(fp.truncated)
        }
      };
    }
  },
  {
    name: "ae_comp_diff",
    description: "Take a fresh composition fingerprint in a separate evalScript and return the exact property/layer diff (`{changed, added, removed}`) against a stored `before_id` fingerprint. " + AGENT_SAFETY_GUIDANCE,
    schema: AeCompDiffSchema,
    handler: async (args, ctx) => {
      const beforeEntry = getStoredFingerprint(args.before_id);
      if (!beforeEntry) {
        throw new BridgeError({
          kind: "evalscript_error",
          message: `Unknown or evicted fingerprint before_id "${args.before_id}". Take a new fingerprint with ae_comp_fingerprint first.`
        });
      }
      const compId = args.comp_id ?? beforeEntry.comp_id;
      const res = await ctx.bridge.callHost(
        "compFingerprint",
        { comp_id: compId },
        {
          label: `ae_comp_diff(${compId})`,
          mutates: false,
          toolName: "ae_comp_diff"
        }
      );
      const afterFp = res.result;
      const afterEntry = storeFingerprint(afterFp);
      const diff = diffFingerprints(beforeEntry.fingerprint, afterFp);
      return {
        before_id: beforeEntry.id,
        after_id: afterEntry.id,
        comp_id: compId,
        truncated: Boolean(beforeEntry.fingerprint.truncated || afterFp.truncated),
        changed: diff.changed,
        added: diff.added,
        removed: diff.removed,
        diff
      };
    }
  },
  {
    name: "ae_checkpoint_create",
    description: "Create an `.aep` checkpoint of the currently saved project by copying the file on disk with Node fs to `<projectdir>/_mcp_checkpoints/<name>_<yyyyMMdd-HHmmss>_<label>.aep`. Never uses After Effects Save As so the active project path is never retargeted. " + AGENT_SAFETY_GUIDANCE,
    schema: AeCheckpointCreateSchema,
    handler: async (args, ctx) => {
      ctx.quarantine.assertClear();
      const opId = ctx.bridge.newOpId();
      try {
        return await ctx.queue.run("ae_checkpoint_create", async () => {
          ctx.quarantine.assertClear();
          const guardInfo = await verifyTargetGuard(ctx, args.expect, opId);
          const actualProjectPath = guardInfo.project_path ?? args.expect.project_path;
          if (actualProjectPath === "<unsaved>") {
            throw new BridgeError({
              kind: "guard",
              op_id: opId,
              message: "Cannot create a checkpoint for an unsaved project (<unsaved>). Save the project in After Effects first.",
              expected: args.expect,
              actual: { project_path: "<unsaved>" }
            });
          }
          if (!fs20.existsSync(actualProjectPath)) {
            throw new BridgeError({
              kind: "guard",
              op_id: opId,
              message: `Cannot create a checkpoint because the project file does not exist on disk: "${actualProjectPath}". Save the project first.`,
              expected: args.expect,
              actual: { project_path: actualProjectPath }
            });
          }
          const ext2 = path20.extname(actualProjectPath) || ".aep";
          const baseName = path20.basename(actualProjectPath, ext2);
          const checkpointDir = checkpointDirFor(actualProjectPath);
          fs20.mkdirSync(checkpointDir, { recursive: true });
          const stamp = formatBackupTimestamp(/* @__PURE__ */ new Date());
          const safeLabel = sanitizeCheckpointLabel(args.label);
          const checkpointFileName = `${baseName}_${stamp}_${safeLabel}${ext2}`;
          const checkpointPath = path20.join(checkpointDir, checkpointFileName);
          fs20.copyFileSync(actualProjectPath, checkpointPath);
          const stat = fs20.statSync(checkpointPath);
          const receipt = buildReceipt({
            before: {
              project_path: actualProjectPath,
              checkpoint_exists: false
            },
            after: {
              project_path: actualProjectPath,
              checkpoint_path: checkpointPath,
              checkpoint_exists: true,
              size: stat.size
            },
            expected: {
              checkpoint_exists: true
            },
            actualForExpected: {
              checkpoint_exists: fs20.existsSync(checkpointPath)
            }
          });
          return {
            op_id: opId,
            applied: true,
            project_path: actualProjectPath,
            checkpoint_path: checkpointPath,
            label: safeLabel,
            size: stat.size,
            receipt
          };
        });
      } catch (err) {
        if (err instanceof QueueWaitError) {
          throw new BridgeError({
            kind: "queued",
            op_id: opId,
            message: err.message
          });
        }
        throw err;
      }
    }
  },
  {
    name: "ae_checkpoint_list",
    description: "List `.aep` checkpoint files in `<projectdir>/_mcp_checkpoints`, guarded by `expect`. " + AGENT_SAFETY_GUIDANCE,
    schema: AeCheckpointListSchema,
    handler: async (args, ctx) => {
      const opId = ctx.bridge.newOpId();
      const guardInfo = await verifyTargetGuard(ctx, args.expect, opId);
      const actualProjectPath = guardInfo.project_path ?? args.expect.project_path;
      if (actualProjectPath === "<unsaved>") {
        throw new BridgeError({
          kind: "guard",
          op_id: opId,
          message: "Cannot list checkpoints for an unsaved project (<unsaved>).",
          expected: args.expect,
          actual: { project_path: "<unsaved>" }
        });
      }
      const checkpointDir = checkpointDirFor(actualProjectPath);
      if (!fs20.existsSync(checkpointDir)) {
        return {
          project_path: actualProjectPath,
          checkpoint_dir: checkpointDir,
          checkpoints: [],
          truncated: false
        };
      }
      const entries = fs20.readdirSync(checkpointDir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".aep"));
      const items = entries.map((e) => {
        const fullPath = path20.join(checkpointDir, e.name);
        const stat = fs20.statSync(fullPath);
        return {
          name: e.name,
          path: fullPath,
          auto: /_auto-[A-Za-z0-9_]+(-\d+)?\.aepx?$/i.test(e.name),
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          created_at: stat.mtime.toISOString()
        };
      }).sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
      const truncated = items.length > MAX_LIST_ENTRIES;
      const bounded = items.slice(0, MAX_LIST_ENTRIES).map(({ mtimeMs: _m, ...rest }) => rest);
      return {
        project_path: actualProjectPath,
        checkpoint_dir: checkpointDir,
        checkpoints: bounded,
        truncated
      };
    }
  },
  {
    name: "ae_auto_checkpoint",
    description: `Read or change automatic checkpoints. Before every write (${AUTO_CHECKPOINT_TOOLS.join(", ")}; ae_run_jsx only with mutates: true), the server copies the saved .aep to \`<projectdir>/_mcp_checkpoints/<name>_<stamp>_auto-<tool>.aep\` and reports it as \`checkpoint\` in the write's result. ae_checkpoint_list shows them (\`auto: true\`) and ae_checkpoint_revert opens one. AE can't write its unsaved state to another file without retargeting the project, so the copy is the LAST SAVE: when AE has unsaved changes, \`checkpoint.unsaved_changes_not_included\` is true. Writes between two saves share one copy. Unsaved projects and projects over \`max_mb\` are skipped, and a failed copy never blocks the write. Call with no arguments to read the settings. Change them only when the user asks (for example, to turn checkpoints off for a very large project); they persist across restarts. ` + AGENT_SAFETY_GUIDANCE,
    schema: AeAutoCheckpointSchema,
    handler: async (args, ctx) => {
      if (!ctx.settings) {
        throw new BridgeError({
          kind: "evalscript_error",
          message: "This server has no settings store, so auto checkpoints use the defaults and can't be changed."
        });
      }
      const changed = args.enabled !== void 0 || args.max_mb !== void 0;
      const settings = changed ? ctx.settings.updateAutoCheckpoint({ enabled: args.enabled, max_mb: args.max_mb }) : ctx.settings.get();
      return {
        changed,
        auto_checkpoint: settings.auto_checkpoint,
        applies_to: AUTO_CHECKPOINT_TOOLS,
        settings_path: ctx.settings.path
      };
    }
  },
  {
    name: "ae_checkpoint_revert",
    description: "Revert to a checkpoint `.aep` file using `openProject` (closes current project with `CloseOptions.DO_NOT_SAVE_CHANGES` only when allowed and calls `app.open`). Refuses if the open project is dirty unless `discard_changes: true` is explicitly passed. " + AGENT_SAFETY_GUIDANCE,
    schema: AeCheckpointRevertSchema,
    handler: async (args, ctx) => {
      ctx.quarantine.assertClear();
      const opId = ctx.bridge.newOpId();
      try {
        return await ctx.queue.run("ae_checkpoint_revert", async () => {
          ctx.quarantine.assertClear();
          const guardInfo = await verifyTargetGuard(ctx, args.expect, opId);
          const actualProjectPath = guardInfo.project_path ?? args.expect.project_path;
          if (!fs20.existsSync(args.checkpoint_path)) {
            throw new BridgeError({
              kind: "guard",
              op_id: opId,
              message: `Checkpoint file does not exist on disk: "${args.checkpoint_path}".`,
              expected: { checkpoint_path: args.checkpoint_path },
              actual: { exists: false }
            });
          }
          const beforeStatus = await ctx.bridge.evalRaw({
            id: `${opId}_before`,
            script: buildJsxCall("status", {}),
            label: "ae_checkpoint_revert (before status)",
            mutates: false,
            toolName: "ae_checkpoint_revert"
          });
          const isDirty2 = Boolean(beforeStatus.result?.dirty);
          const discardChanges = Boolean(args.discard_changes);
          if (isDirty2 && !discardChanges) {
            throw new BridgeError({
              kind: "guard",
              op_id: opId,
              message: "Refusing to revert checkpoint: the open project has unsaved changes (dirty: true) and discard_changes is not true.",
              expected: { dirty: false, discard_changes: true },
              actual: {
                project_path: actualProjectPath,
                dirty: true
              }
            });
          }
          const openResp = await ctx.bridge.evalRaw({
            id: opId,
            script: buildJsxCall("openProject", {
              path: args.checkpoint_path,
              discard_changes: discardChanges,
              expect: args.expect
            }),
            label: "ae_checkpoint_revert",
            timeoutMs: SLOW_TIMEOUT_MS,
            mutates: true,
            toolName: "ae_checkpoint_revert"
          });
          const afterStatus = await ctx.bridge.evalRaw({
            id: `${opId}_after`,
            script: buildJsxCall("status", {}),
            label: "ae_checkpoint_revert (after status)",
            mutates: false,
            toolName: "ae_checkpoint_revert"
          });
          const reopenedPath = afterStatus.result?.project_path ?? openResp.result?.project_path ?? args.checkpoint_path;
          const receipt = buildReceipt({
            before: beforeStatus.result ?? {
              project_path: actualProjectPath,
              dirty: isDirty2
            },
            after: afterStatus.result ?? {
              project_path: reopenedPath,
              dirty: false
            },
            expected: {
              project_path: args.checkpoint_path
            },
            actualForExpected: {
              project_path: reopenedPath
            }
          });
          return {
            op_id: opId,
            applied: true,
            previous_project_path: actualProjectPath,
            project_path: reopenedPath,
            checkpoint_path: args.checkpoint_path,
            discarded_changes: isDirty2 && discardChanges,
            result: openResp.result,
            receipt
          };
        });
      } catch (err) {
        if (err instanceof QueueWaitError) {
          throw new BridgeError({
            kind: "queued",
            op_id: opId,
            message: err.message
          });
        }
        throw err;
      }
    }
  }
];

// src/tools/ext/reframe.ts
var DEFAULT_MARGINS = {
  "16:9": { top: 0.05, bottom: 0.05, left: 0.05, right: 0.05 },
  "1:1": { top: 0.06, bottom: 0.06, left: 0.06, right: 0.06 },
  "4:5": { top: 0.06, bottom: 0.06, left: 0.06, right: 0.06 },
  "9:16": { top: 0.12, bottom: 0.2, left: 0.06, right: 0.06 }
};
var FALLBACK_MARGINS = { top: 0.05, bottom: 0.05, left: 0.05, right: 0.05 };
function parseAspect(aspect) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)\s*$/i.exec(aspect);
  if (!m) return void 0;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return w > 0 && h > 0 ? w / h : void 0;
}
var MIN_SIZE = 4;
var MAX_SIZE = 3e4;
function even(n) {
  return Math.max(4, Math.round(n / 2) * 2);
}
function sizeForAspect(srcW, srcH, ratio) {
  const short = Math.min(srcW, srcH);
  if (ratio >= 1) return { width: even(short * ratio), height: even(short) };
  return { width: even(short), height: even(short / ratio) };
}
function aspectName(w, h) {
  const r = w / h;
  return Object.keys(DEFAULT_MARGINS).find((k) => Math.abs(parseAspect(k) - r) / r < 0.01);
}
function marginsFor(w, h, override) {
  const base = DEFAULT_MARGINS[aspectName(w, h) ?? ""] ?? FALLBACK_MARGINS;
  return { ...base, ...override ?? {} };
}
var MarginsSchema = external_exports.object({
  top: external_exports.number().min(0).max(0.45).optional(),
  bottom: external_exports.number().min(0).max(0.45).optional(),
  left: external_exports.number().min(0).max(0.45).optional(),
  right: external_exports.number().min(0).max(0.45).optional()
}).describe("Safe margins as fractions of the frame, e.g. { bottom: 0.25 } for a platform with a tall caption area.");
var AeReframeSchema = external_exports.object({
  comp_id: external_exports.number().int().describe("The approved comp to reframe."),
  targets: external_exports.array(
    external_exports.object({
      aspect: external_exports.string().min(3).describe("'16:9', '1:1', '4:5', '9:16', or any 'w:h'."),
      width: external_exports.number().int().min(4).max(3e4).optional().describe("Exact size instead of keeping the source's short side."),
      height: external_exports.number().int().min(4).max(3e4).optional(),
      name: external_exports.string().min(1).max(200).optional().describe("Default '<comp> <w>x<h>'."),
      margins: MarginsSchema.optional()
    })
  ).min(1).max(6),
  source_margins: MarginsSchema.optional().describe("The source comp's safe margins, if not the defaults for its aspect."),
  shrink: external_exports.boolean().optional().describe("Shrink a pinned layer that no longer fits the safe area. Default true."),
  guide: external_exports.boolean().optional().describe("Add a guide layer (not rendered) outlining the safe area. Default true."),
  expect: ExpectSchema
});
function planTargets(args, srcW, srcH, srcName) {
  const problems = [];
  const targets = args.targets.map((t) => {
    const ratio = parseAspect(t.aspect);
    let size;
    if (t.width && t.height) {
      size = { width: t.width, height: t.height };
    } else if (ratio === void 0) {
      problems.push(`"${t.aspect}" is not an aspect like 9:16`);
      size = { width: srcW, height: srcH };
    } else if (t.width) {
      size = { width: t.width, height: even(t.width / ratio) };
    } else if (t.height) {
      size = { width: even(t.height * ratio), height: t.height };
    } else {
      size = sizeForAspect(srcW, srcH, ratio);
    }
    if (size.width < MIN_SIZE || size.height < MIN_SIZE || size.width > MAX_SIZE || size.height > MAX_SIZE) {
      problems.push(`"${t.aspect}" gives ${size.width}x${size.height}; a comp must be ${MIN_SIZE} to ${MAX_SIZE} pixels on each side (give width and height)`);
    }
    return {
      aspect: t.aspect,
      name: t.name ?? `${srcName} ${size.width}x${size.height}`,
      width: size.width,
      height: size.height,
      margins: marginsFor(size.width, size.height, t.margins)
    };
  });
  return { targets, problems };
}
var reframeTools = [
  {
    name: "ae_reframe",
    description: "Social cut-downs: copy a comp to other aspects (16:9, 1:1, 4:5, 9:16, or any w:h; the source's short side is kept, so 1920x1080 gives 1080x1920) and re-lay out its top-level layers. Backgrounds (footage, solids, adjustment and shape layers covering the frame) are scaled to cover the new frame. Everything else, controller nulls included, is pinned to the nearest edge or centre of the safe area, keeping its margin, and shrunk if it no longer fits; keys move with it; children follow their parent. 3D layers, cameras and lights move with the frame's centre. Precomps are treated like any other layer (shrunk to fit), so reframe inside them if they need their own layout. Default safe margins: 5% on 16:9, 6% on 1:1 and 4:5, and on 9:16 12% top, 20% bottom, 6% sides for platform UI; override with `margins` (a brief's platform numbers win). A guide layer outlines the safe area. One undo group for every size, guarded by `expect`, with an auto checkpoint. The layout is read back in a separate evalScript: `outside_safe` lists layers still past the safe area. Look at each new comp (ae_contact_sheet) before calling it done. " + AGENT_SAFETY_GUIDANCE,
    schema: AeReframeSchema,
    handler: async (args, ctx) => {
      const src = await ctx.bridge.evalRaw({
        id: `${ctx.bridge.newOpId()}_reframe_src`,
        script: buildJsxCall("getComp", { comp_id: args.comp_id }),
        label: "ae_reframe (source)",
        mutates: false,
        toolName: "ae_reframe"
      });
      const { width: srcW, height: srcH, name: srcName } = src.result;
      const { targets, problems } = planTargets(args, srcW, srcH, srcName);
      if (problems.length > 0) return { ok: false, error: "bad_args", problems };
      ctx.quarantine.assertClear();
      const expect = { project_path: args.expect.project_path, comp_id: args.expect.comp_id ?? args.comp_id };
      const opId = ctx.bridge.newOpId();
      const projectSnapshot = (suffix) => ctx.bridge.evalRaw({
        id: `${opId}_${suffix}`,
        script: buildJsxCall("snapshotForReceipt", {}),
        label: `ae_reframe (${suffix} snapshot)`,
        mutates: false,
        toolName: "ae_reframe"
      });
      try {
        return await ctx.queue.run("ae_reframe", async () => {
          ctx.quarantine.assertClear();
          const guard = await verifyTargetGuard(ctx, expect, opId);
          const checkpoint = await autoCheckpoint(ctx, guard, "ae_reframe");
          const before = await projectSnapshot("before");
          const write = await ctx.bridge.evalRaw({
            id: opId,
            script: buildJsxCall("reframeComp", {
              expect,
              comp_id: args.comp_id,
              targets,
              source_margins: marginsFor(srcW, srcH, args.source_margins),
              shrink: args.shrink !== false,
              guide: args.guide !== false
            }),
            label: `ae_reframe(${targets.map((t) => t.aspect).join(", ")})`,
            mutates: true,
            toolName: "ae_reframe"
          });
          const made = write.result.comps;
          const after = await projectSnapshot("after");
          const report = await ctx.bridge.evalRaw({
            id: `${opId}_report`,
            script: buildJsxCall("reframeReport", { comps: made.map((m) => ({ comp_id: m.comp_id, safe: m.safe })) }),
            label: "ae_reframe (read back)",
            mutates: false,
            toolName: "ae_reframe"
          });
          const mismatches = [];
          report.result.comps.forEach((r, i) => {
            const t = targets[i];
            if (r.width !== t.width || r.height !== t.height) {
              mismatches.push({ path: `${t.name}.size`, expected: [t.width, t.height], actual: [r.width, r.height], message: `${t.name} is not ${t.width}x${t.height}` });
            }
          });
          return {
            ok: true,
            op_id: opId,
            applied: true,
            source: write.result.source,
            comps: made.map((m, i) => ({
              ...m,
              aspect: targets[i].aspect,
              margins: targets[i].margins,
              outside_safe: report.result.comps[i]?.outside_safe ?? []
            })),
            next: "Check each new comp with ae_contact_sheet; nudge anything in outside_safe with ae_set_property.",
            checkpoint,
            receipt: buildReceipt({ before: before.result, after: after.result, customMismatches: mismatches })
          };
        });
      } catch (err) {
        if (err instanceof QueueWaitError) {
          throw new BridgeError({ kind: "queued", op_id: opId, message: err.message });
        }
        throw err;
      }
    }
  }
];

// src/es3-lint.ts
function lineAt(source, index) {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}
var REGEX_AFTER_PUNCT = /^[([{:;,=+\-*!&|?~^%<>]$/;
var REGEX_AFTER_WORD = /* @__PURE__ */ new Set(["return", "typeof", "case", "in", "instanceof", "new", "delete", "void", "throw", "else", "do"]);
function startsRegex(prev, postfix) {
  if (prev === "") return true;
  if (postfix) return false;
  return REGEX_AFTER_PUNCT.test(prev) || REGEX_AFTER_WORD.has(prev);
}
function strip(source, findings) {
  const out = [];
  const len = source.length;
  let i = 0;
  let prev = "";
  let postfix = false;
  const skipQuoted = (quote) => {
    out.push(" ");
    i++;
    while (i < len) {
      const c = source[i];
      if (c === "\\") {
        out.push(" ");
        i++;
        if (i < len) {
          out.push(source[i] === "\n" ? "\n" : " ");
          i++;
        }
        continue;
      }
      if (c === quote) {
        out.push(" ");
        i++;
        break;
      }
      out.push(c === "\n" ? "\n" : " ");
      i++;
    }
    prev = quote;
    postfix = false;
  };
  while (i < len) {
    const ch = source[i];
    const next = i + 1 < len ? source[i + 1] : "";
    if (ch === "/" && next === "/") {
      while (i < len && source[i] !== "\n") {
        out.push(" ");
        i++;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      out.push(" ", " ");
      i += 2;
      while (i < len) {
        if (source[i] === "*" && source[i + 1] === "/") {
          out.push(" ", " ");
          i += 2;
          break;
        }
        out.push(source[i] === "\n" ? "\n" : " ");
        i++;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      skipQuoted(ch);
      continue;
    }
    if (ch === "`") {
      findings.push({ line: lineAt(source, i), message: "backtick template strings are not ES3; use quotes and +" });
      skipQuoted("`");
      continue;
    }
    if (ch === "/" && startsRegex(prev, postfix)) {
      out.push(" ");
      i++;
      let inClass = false;
      while (i < len) {
        const c = source[i];
        if (c === "\\") {
          out.push(" ");
          i++;
          if (i < len) {
            out.push(source[i] === "\n" ? "\n" : " ");
            i++;
          }
          continue;
        }
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) {
          out.push(" ");
          i++;
          while (i < len && /[a-z]/i.test(source[i])) {
            out.push(" ");
            i++;
          }
          break;
        }
        out.push(c === "\n" ? "\n" : " ");
        i++;
      }
      prev = "/";
      postfix = false;
      continue;
    }
    if (/[A-Za-z0-9_$]/.test(ch)) {
      let end = i;
      while (end < len && /[A-Za-z0-9_$]/.test(source[end])) end++;
      out.push(source.substring(i, end));
      prev = source.substring(i, end);
      postfix = false;
      i = end;
      continue;
    }
    out.push(ch);
    if (!/\s/.test(ch)) {
      postfix = (ch === "+" || ch === "-") && prev === ch && !postfix;
      prev = ch;
    }
    i++;
  }
  return out.join("");
}
var FORBIDDEN = [
  { regex: /\blet\b/g, message: "'let' is not ES3; use var" },
  { regex: /\bconst\b/g, message: "'const' is not ES3; use var" },
  { regex: /\bclass\b/g, message: "'class' is not ES3; use functions" },
  { regex: /=>/g, message: "arrow functions are not ES3; use function () {}" }
];
var STATEMENT_STARTERS = /* @__PURE__ */ new Set([
  "var",
  "function",
  "return",
  "throw",
  "if",
  "else",
  "while",
  "for",
  "do",
  "switch",
  "case",
  "default",
  "try",
  "catch",
  "finally"
]);
function chainedTernaries(stripped, findings) {
  let parens = 0;
  let brackets = 0;
  let active = [];
  const len = stripped.length;
  let i = 0;
  while (i < len) {
    const ch = stripped[i];
    if (/[a-zA-Z_$]/.test(ch)) {
      let end = i;
      while (end < len && /[a-zA-Z0-9_$]/.test(stripped[end])) end++;
      if (STATEMENT_STARTERS.has(stripped.substring(i, end))) active = [];
      i = end;
      continue;
    }
    const depth = parens + brackets;
    if (ch === "(") parens++;
    else if (ch === "[") brackets++;
    else if (ch === ")" || ch === "]") {
      if (ch === ")" && parens > 0) parens--;
      if (ch === "]" && brackets > 0) brackets--;
      const d = parens + brackets;
      active = active.filter((t) => t.depth <= d);
    } else if (ch === "{" || ch === "}" || ch === ";") {
      active = [];
    } else if (ch === ",") {
      active = active.filter((t) => !(t.hasColon && t.depth >= depth));
    } else if (ch === "?") {
      if (active.some((t) => t.hasColon)) {
        findings.push({ line: lineAt(stripped, i), message: "chained ternary: ExtendScript parses it left to right; use if / else" });
      }
      active.push({ depth, hasColon: false });
    } else if (ch === ":") {
      for (let j = active.length - 1; j >= 0; j--) {
        if (!active[j].hasColon) {
          active[j].hasColon = true;
          break;
        }
      }
    }
    i++;
  }
}
function lintEs3(source) {
  const findings = [];
  const stripped = strip(source, findings);
  for (const { regex, message } of FORBIDDEN) {
    regex.lastIndex = 0;
    let m;
    while ((m = regex.exec(stripped)) !== null) findings.push({ line: lineAt(stripped, m.index), message });
  }
  chainedTernaries(stripped, findings);
  return findings.sort((a, b) => a.line - b.line);
}

// src/tools/ext/skills.ts
var SkillNameSchema = external_exports.string().regex(SKILL_NAME_RE, "lowercase letters, digits and dashes, up to 64 characters").refine(isValidSkillName, "not a Windows device name (con, prn, aux, nul, com1-9, lpt1-9)").describe("Skill name, e.g. 'lower-third' (lowercase letters, digits, dashes).");
var AeSkillListSchema = external_exports.object({
  name: SkillNameSchema.optional().describe("Give a name to get that skill in full: instructions and the code of every step."),
  recent_jsx: external_exports.boolean().optional().describe("Also list the recent successful ae_run_jsx calls (op_id, label), for ae_skill_save from_op_ids.")
});
var AeSkillSaveSchema = external_exports.object({
  name: SkillNameSchema,
  description: external_exports.string().min(1).max(300).describe("One line: what the skill makes and when to use it."),
  instructions: external_exports.string().max(2e4).optional().describe("Markdown for whoever runs it next: what args it takes, what it builds, what to check afterwards."),
  steps: external_exports.array(external_exports.string().min(1).max(2e5)).min(1).max(20).optional().describe("ExtendScript function bodies, run in order; each sees `args`, `prev` (the previous step's return) and `results`."),
  from_op_ids: external_exports.array(external_exports.string().min(1)).min(1).max(20).optional().describe("op_ids of ae_run_jsx calls that worked in this session (in step order); their code becomes the steps."),
  mutates: external_exports.boolean().optional().describe("False for a skill that only reads. Default: true, or for from_op_ids, true if any of the calls wrote."),
  args_example: external_exports.record(external_exports.unknown()).optional().describe("Example arguments, saved so the next caller sees the shape."),
  scope: external_exports.enum(["project", "global"]).describe("project: next to the open .aep (ae-skills/); global: every project on this machine."),
  overwrite: external_exports.boolean().optional().describe("Replace a skill with the same name in that scope."),
  expect: external_exports.object({ project_path: external_exports.string().min(1) }).optional().describe("Required for scope 'project': the open project's path, so the skill lands next to the right .aep.")
}).refine((v) => v.steps === void 0 !== (v.from_op_ids === void 0), {
  message: "Give either steps or from_op_ids."
}).refine((v) => v.scope !== "project" || v.expect !== void 0, {
  message: "A project skill needs expect.project_path."
});
var AeSkillRunSchema = external_exports.object({
  name: SkillNameSchema,
  scope: external_exports.enum(["project", "global"]).optional().describe("Where to look. Default: the project's skills first, then global."),
  args: external_exports.record(external_exports.unknown()).optional().describe("Arguments the steps read as `args`; see the skill's instructions and args_example."),
  expect: ExpectSchema.optional().describe("Required for skills that write. comp_id also picks the comp for the receipt.")
});
async function openProjectPath2(ctx, toolName) {
  const res = await ctx.bridge.evalRaw({
    id: `${ctx.bridge.newOpId()}_skills_status`,
    script: buildJsxCall("status", {}),
    label: `${toolName} (project path)`,
    mutates: false,
    toolName
  });
  return res.result?.project_path ?? "<unsaved>";
}
function roots(ctx, projectPath, only) {
  const out = [];
  if (projectPath !== "<unsaved>" && only !== "global") out.push({ scope: "project", root: projectSkillsRoot(projectPath) });
  if (only !== "project") out.push({ scope: "global", root: globalSkillsRoot(dataDirOf(ctx)) });
  return out;
}
function summary(s) {
  return {
    name: s.name,
    display_name: s.display_name,
    description: s.description,
    error: s.error,
    scope: s.scope,
    mutates: s.mutates,
    steps: s.steps.length,
    args_example: s.args_example,
    dir: s.dir
  };
}
function unreadable(skill) {
  return { ok: false, error: "unreadable_skill", message: `Skill "${skill.name}" in ${skill.dir} can't be read: ${skill.error}` };
}
function lintSteps(steps) {
  const problems = [];
  for (const step of steps) {
    for (const f of lintEs3(step.code)) problems.push(`${step.file} line ${f.line}: ${f.message}`);
  }
  return problems;
}
var skillsTools = [
  {
    name: "ae_skill_list",
    description: "List AE skills: reusable recipes (house rigs, lower thirds, kinetic type, cleanup passes) kept as SKILL.md plus numbered ExtendScript steps. Project skills live next to the open .aep in ae-skills/ and travel with it; global skills are kept for every project on this machine. A project skill hides a global one with the same name. Check here before building something by hand: the user may already have a skill for it. Give `name` to read one in full. Read-only.",
    schema: AeSkillListSchema,
    handler: async (args, ctx) => {
      const projectPath = await openProjectPath2(ctx, "ae_skill_list");
      const where = roots(ctx, projectPath);
      const recent = args.recent_jsx ? {
        recent_jsx: recentRunJsx().map((r) => ({
          op_id: r.op_id,
          label: r.label,
          mutates: r.mutates,
          at: r.at,
          first_line: r.code.split(/\r?\n/)[0].slice(0, 120)
        }))
      } : {};
      if (args.name) {
        const skill = findSkill(where, args.name);
        if (!skill) {
          return { ok: false, error: "not_found", message: `No skill named "${args.name}".`, roots: where, ...recent };
        }
        if (skill.error) return unreadable(skill);
        return { ok: true, skill: { ...summary(skill), instructions: skill.instructions, steps: skill.steps }, ...recent };
      }
      const skills = listSkills(where);
      return {
        ok: true,
        project_path: projectPath,
        roots: where,
        count: skills.length,
        skills: skills.map(summary),
        ...recent
      };
    }
  },
  {
    name: "ae_skill_save",
    description: "Save an AE skill: a description, instructions, and ExtendScript steps that run in order. Steps come from `steps` (function bodies, as for ae_run_jsx) or from `from_op_ids`, the op_ids of ae_run_jsx calls that worked in this session, so a script that did the job is kept exactly as it ran. Each step sees `args` (the run's arguments), `prev` (what the previous step returned) and `results`. Write steps that take what varies (text, colours, comp_id, layer names) from `args`, not hard-coded. Steps are checked for ES3 (no let, const, arrow functions, template strings, class, or chained ternaries) and refused with the line if they break it. Save only when the user asks for it or agrees. Never touches the AE project.",
    schema: AeSkillSaveSchema,
    handler: async (args, ctx) => {
      let steps;
      let mutates = args.mutates;
      if (args.from_op_ids) {
        const found = args.from_op_ids.map((id) => ({ id, rec: recordedRunJsx(id) }));
        const missing = found.filter((f) => !f.rec).map((f) => f.id);
        if (missing.length > 0) {
          return {
            ok: false,
            error: "unknown_op_id",
            message: `No successful ae_run_jsx with op_id ${missing.join(", ")} in this session (the last 50 are kept). Pass the code as steps instead.`
          };
        }
        steps = found.map((f) => f.rec.code);
        if (mutates === void 0) mutates = found.some((f) => f.rec.mutates);
      } else {
        steps = args.steps;
      }
      const tooBig = oversizedSteps(steps);
      if (tooBig.length > 0) {
        return { ok: false, error: "step_too_large", message: "A step is too large for a skill. Nothing was saved.", problems: tooBig };
      }
      const problems = lintSteps(steps.map((code, i) => ({ file: `${i + 1}.jsx`, code })));
      if (problems.length > 0) {
        return { ok: false, error: "not_es3", message: "Steps use syntax After Effects' ExtendScript (ES3) can't run. Nothing was saved.", problems };
      }
      let root;
      if (args.scope === "project") {
        const projectPath = await openProjectPath2(ctx, "ae_skill_save");
        if (projectPath === "<unsaved>") {
          return { ok: false, error: "unsaved_project", message: "The project has not been saved, so there is no folder for project skills. Save it, or use scope 'global'." };
        }
        if (normalizeGuardPath(args.expect.project_path) !== normalizeGuardPath(projectPath)) {
          return { ok: false, error: "guard", message: `The open project is ${projectPath}, not ${args.expect.project_path}. Re-read state; nothing was saved.` };
        }
        root = projectSkillsRoot(projectPath);
      } else {
        root = globalSkillsRoot(dataDirOf(ctx));
      }
      try {
        const written = writeSkill(
          root,
          {
            name: args.name,
            description: args.description,
            mutates: mutates ?? true,
            args_example: args.args_example ? JSON.stringify(args.args_example) : void 0
          },
          args.instructions ?? `# ${args.name}

${args.description}`,
          steps,
          args.overwrite === true
        );
        return { ok: true, scope: args.scope, name: args.name, mutates: mutates ?? true, steps: steps.length, ...written };
      } catch (err) {
        return { ok: false, error: "write_failed", message: err instanceof Error ? err.message : String(err) };
      }
    }
  },
  {
    name: "ae_skill_run",
    description: "Run an AE skill: its numbered steps run in order in one evalScript, so a writing skill is a single undo step (Edit > Undo takes it all back). Writing skills need `expect` (guarded like every write, with an auto checkpoint and a before/after receipt of expect.comp_id read back separately). Pass `expect` unless you have read the steps and they only read: with `expect` the skill always runs guarded, even if its SKILL.md says it only reads. Pass what varies in `args`; read the skill first with ae_skill_list { name } to see its instructions. Each step's return value comes back in `results`. If a step fails, the error names the step and line; steps before it have already run inside the undo group. " + AGENT_SAFETY_GUIDANCE,
    schema: AeSkillRunSchema,
    handler: async (args, ctx) => {
      const projectPath = await openProjectPath2(ctx, "ae_skill_run");
      const skill = findSkill(roots(ctx, projectPath, args.scope), args.name);
      if (!skill) {
        return { ok: false, error: "not_found", message: `No skill named "${args.name}". See ae_skill_list.` };
      }
      if (skill.error) return unreadable(skill);
      if (skill.steps.length === 0) {
        return { ok: false, error: "no_steps", message: `Skill "${skill.name}" has no numbered .jsx steps in ${skill.dir}.` };
      }
      const problems = lintSteps(skill.steps);
      if (problems.length > 0) {
        return { ok: false, error: "not_es3", message: "The skill's steps use syntax ExtendScript (ES3) can't run. Nothing ran.", problems };
      }
      const label = `Chroma AE MCP: skill ${skill.name}`;
      const guarded = skill.mutates || args.expect !== void 0;
      const hostArgs = { steps: skill.steps, args: args.args ?? {}, label, mutates: guarded };
      const about = { skill: skill.name, scope: skill.scope, dir: skill.dir, steps: skill.steps.length };
      if (!guarded) {
        const res = await ctx.bridge.callHost("runSkill", hostArgs, { label: `ae_skill_run: ${skill.name}`, mutates: false, toolName: "ae_skill_run" });
        return { ok: true, ...about, ...res.result };
      }
      if (!args.expect) {
        return { ok: false, error: "needs_expect", message: `Skill "${skill.name}" writes to the project, so it needs expect (project_path, and comp_id for the receipt).` };
      }
      ctx.quarantine.assertClear();
      const expect = args.expect;
      const opId = ctx.bridge.newOpId();
      const snapshot = (suffix) => ctx.bridge.evalRaw({
        id: `${opId}_${suffix}`,
        script: buildJsxCall("snapshotForReceipt", { comp_id: expect.comp_id }),
        label: `${label} (${suffix} snapshot)`,
        mutates: false,
        toolName: "ae_skill_run"
      });
      try {
        return await ctx.queue.run(`ae_skill_run: ${skill.name}`, async () => {
          ctx.quarantine.assertClear();
          const guard = await verifyTargetGuard(ctx, expect, opId);
          const checkpoint = await autoCheckpoint(ctx, guard, "ae_skill_run");
          const before = await snapshot("before");
          const write = await ctx.bridge.evalRaw({
            id: opId,
            script: buildJsxCall("runSkill", { ...hostArgs, expect }),
            label,
            mutates: true,
            toolName: "ae_skill_run"
          });
          const after = await snapshot("after");
          return {
            ok: true,
            op_id: opId,
            applied: true,
            ...about,
            ...write.result ?? {},
            checkpoint,
            receipt: buildReceipt({ before: before.result, after: after.result })
          };
        });
      } catch (err) {
        if (err instanceof QueueWaitError) {
          throw new BridgeError({ kind: "queued", op_id: opId, message: err.message });
        }
        throw err;
      }
    }
  }
];

// src/tools/ext/track.ts
var fs21 = __toESM(require("node:fs"), 1);
var path21 = __toESM(require("node:path"), 1);
function toGray(img) {
  const n = img.width * img.height;
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const j = i * 4;
    data[i] = 0.2126 * img.data[j] + 0.7152 * img.data[j + 1] + 0.0722 * img.data[j + 2];
  }
  return { width: img.width, height: img.height, data };
}
function extractPatch(img, cx, cy, size) {
  const h = (size - 1) / 2;
  if (cx - h < 0 || cy - h < 0 || cx + h > img.width - 1 || cy + h > img.height - 1) return null;
  const data = new Float32Array(size * size);
  for (let py = 0; py < size; py++) {
    const y = cy - h + py;
    const y0 = Math.min(img.height - 2, Math.floor(y));
    const fy = y - y0;
    for (let px = 0; px < size; px++) {
      const x = cx - h + px;
      const x0 = Math.min(img.width - 2, Math.floor(x));
      const fx = x - x0;
      const i = y0 * img.width + x0;
      const top = img.data[i] * (1 - fx) + img.data[i + 1] * fx;
      const bottom = img.data[i + img.width] * (1 - fx) + img.data[i + img.width + 1] * fx;
      data[py * size + px] = top * (1 - fy) + bottom * fy;
    }
  }
  return { width: size, height: size, data };
}
function makeTemplate(patch) {
  const n = patch.data.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += patch.data[i];
  const mean = sum / n;
  const centred = new Float32Array(n);
  let sq = 0;
  for (let i = 0; i < n; i++) {
    centred[i] = patch.data[i] - mean;
    sq += centred[i] * centred[i];
  }
  return { size: patch.width, centred, norm: Math.sqrt(sq), std: Math.sqrt(sq / n) };
}
function subPixel(a, b, c) {
  const denom = a - 2 * b + c;
  if (!(denom < 0)) return 0;
  return Math.max(-0.5, Math.min(0.5, (a - c) / (2 * denom)));
}
function matchTemplate(img, tpl, cx, cy, radius) {
  const size = tpl.size;
  const h = (size - 1) / 2;
  const n = size * size;
  const icx = Math.round(cx);
  const icy = Math.round(cy);
  const side = 2 * radius + 1;
  const scores = new Float32Array(side * side).fill(-2);
  let best = -2;
  let bx = 0;
  let by = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    const top = icy + dy - h;
    if (top < 0 || top + size > img.height) continue;
    for (let dx = -radius; dx <= radius; dx++) {
      const left = icx + dx - h;
      if (left < 0 || left + size > img.width) continue;
      let sum = 0;
      let sq = 0;
      let cross = 0;
      for (let py = 0; py < size; py++) {
        const row = (top + py) * img.width + left;
        const trow = py * size;
        for (let px = 0; px < size; px++) {
          const v = img.data[row + px];
          sum += v;
          sq += v * v;
          cross += v * tpl.centred[trow + px];
        }
      }
      const variance = sq - sum * sum / n;
      const score = variance > 1e-6 && tpl.norm > 0 ? cross / (Math.sqrt(variance) * tpl.norm) : 0;
      scores[(dy + radius) * side + dx + radius] = score;
      if (score > best) {
        best = score;
        bx = dx;
        by = dy;
      }
    }
  }
  if (best <= -2) return null;
  const at = (dx, dy) => {
    if (Math.abs(dx) > radius || Math.abs(dy) > radius) return NaN;
    const s = scores[(dy + radius) * side + dx + radius];
    return s <= -2 ? NaN : s;
  };
  const sx = [at(bx - 1, by), best, at(bx + 1, by)];
  const sy = [at(bx, by - 1), best, at(bx, by + 1)];
  const offX = sx.every(Number.isFinite) ? subPixel(sx[0], sx[1], sx[2]) : 0;
  const offY = sy.every(Number.isFinite) ? subPixel(sy[0], sy[1], sy[2]) : 0;
  return { x: icx + bx + offX, y: icy + by + offY, score: best };
}
var MIN_PATTERN_STD = 3;
var PointTracker = class {
  constructor(frame, x, y, opts) {
    this.opts = opts;
    const patch = extractPatch(frame, x, y, opts.patchSize);
    if (!patch) throw new Error("The pattern around that point reaches outside the frame; pick a point further in or use a smaller pattern_size.");
    this.first = makeTemplate(patch);
    if (this.first.std < MIN_PATTERN_STD) {
      throw new Error(
        `The pattern at that point is almost flat (contrast ${this.first.std.toFixed(1)} of 255), so there is nothing to follow. Pick a corner, a mark or an edge crossing, or use a larger pattern_size.`
      );
    }
    this.current = this.first;
    this.last = { x, y };
  }
  first;
  current;
  last;
  velocity = { x: 0, y: 0 };
  get contrast() {
    return this.first.std;
  }
  /** The next frame's position, or null when the point is lost. */
  step(frame) {
    const px = this.last.x + this.velocity.x;
    const py = this.last.y + this.velocity.y;
    const r = this.opts.searchRadius;
    let pick = matchTemplate(frame, this.first, px, py, r);
    let adapted = false;
    if (!pick || pick.score < this.opts.adaptBelow) {
      const alt = this.current === this.first ? null : matchTemplate(frame, this.current, px, py, r);
      if (alt && (!pick || alt.score > pick.score)) {
        pick = alt;
        adapted = true;
      }
    }
    if (!pick || pick.score < this.opts.minConfidence) return null;
    this.velocity = { x: pick.x - this.last.x, y: pick.y - this.last.y };
    this.last = { x: pick.x, y: pick.y };
    const next = extractPatch(frame, pick.x, pick.y, this.opts.patchSize);
    if (next && pick.score < this.opts.adaptBelow) {
      const t = makeTemplate(next);
      if (t.std >= MIN_PATTERN_STD) this.current = t;
    }
    return { x: pick.x, y: pick.y, confidence: pick.score, adapted };
  }
};
function trackTimes(start, end, fps, maxFrames) {
  const times = [];
  const first = Math.round(start * fps);
  const last = Math.round(end * fps);
  const step = last >= first ? 1 : -1;
  for (let f = first; step > 0 ? f <= last : f >= last; f += step) {
    times.push(f / fps);
    if (times.length >= maxFrames) break;
  }
  return times;
}
function drawTrackPreview(frame, points, patchSize, lost, maxSize = 960) {
  const fit = fitWithin(frame.width, frame.height, maxSize);
  const img = resizeArea(frame, fit.width, fit.height);
  const k = fit.width / frame.width;
  const yellow = [255, 214, 0, 255];
  for (let i = 1; i < points.length; i++) {
    drawLine(img, points[i - 1].x * k, points[i - 1].y * k, points[i].x * k, points[i].y * k, 2, yellow);
  }
  const box = Math.max(4, Math.round(patchSize * k));
  const p0 = points[0];
  strokeRect(img, Math.round(p0.x * k - box / 2), Math.round(p0.y * k - box / 2), box, box, 2, [0, 220, 255, 255]);
  const end = points[points.length - 1];
  const mark = Math.max(6, Math.round(box / 2));
  strokeRect(img, Math.round(end.x * k - mark / 2), Math.round(end.y * k - mark / 2), mark, mark, 2, lost ? [255, 60, 60, 255] : [80, 255, 120, 255]);
  return img;
}
var AeTrackPointSchema = external_exports.object({
  comp_id: external_exports.number().int(),
  point: external_exports.array(external_exports.number()).length(2).describe("The feature to follow, [x, y] in comp pixels at the start time. Pick a corner, a mark or an edge crossing, not a flat area."),
  start: external_exports.number().min(0).optional().describe("Seconds. Default: the work area start."),
  end: external_exports.number().min(0).optional().describe("Seconds. Default: the work area end. An end before the start tracks backwards."),
  pattern_size: external_exports.number().int().min(9).max(201).optional().describe("Side of the square pattern in comp pixels (odd). Default 31."),
  search_radius: external_exports.number().int().min(2).max(300).optional().describe("How far (px) from the predicted position to look each frame. Default 40; raise it for fast motion."),
  min_confidence: external_exports.number().min(0).max(1).optional().describe("Below this match score (0..1) the point counts as lost and tracking stops. Default 0.6."),
  apply: external_exports.object({
    null_name: external_exports.string().min(1).max(200).describe("Name of the new null layer that gets the track as Position keys, one per frame."),
    expect: ExpectSchema
  }).optional().describe("Write the track to a new null, in one undo step guarded by `expect`. Without it the tool only measures.")
});
var MAX_TRACK_FRAMES = 1e3;
async function queued2(ctx, label, opId, fn) {
  try {
    return await ctx.queue.run(label, fn);
  } catch (err) {
    if (err instanceof QueueWaitError) throw new BridgeError({ kind: "queued", op_id: opId, message: err.message });
    throw err;
  }
}
var trackTools = [
  {
    name: "ae_track_point",
    description: "Track one point through a comp, inside the MCP (nothing to install): AE renders each frame and the server follows the pattern around `point` by normalized cross-correlation with sub-pixel refinement, adapting the pattern when confidence drops below 80% as AE's own tracker does. It tracks the comp's rendered image, so layers above the plate (titles, overlays) can get in the way; track in a comp or precomp that shows the plate. Returns the path in comp pixels with a confidence per frame, where the point was lost if it was, and `preview_path`: the first frame with the path drawn (cyan box = pattern, green = end, red = lost). Look at the preview before using the track. With `apply`, the path becomes Position keys on a new null in one undo step (guarded, read back); parent layers to it with ae_run_jsx. Every frame is a render, so long shots take a while. " + AGENT_SAFETY_GUIDANCE,
    schema: AeTrackPointSchema,
    handler: async (args, ctx) => {
      const opId = ctx.bridge.newOpId();
      const framesDir = defaultFramesDir();
      fs21.mkdirSync(framesDir, { recursive: true });
      const patchSize = (args.pattern_size ?? 31) | 1;
      const opts = {
        patchSize,
        searchRadius: args.search_radius ?? 40,
        minConfidence: args.min_confidence ?? 0.6,
        adaptBelow: 0.8
      };
      const label = `ae_track_point(${args.comp_id})`;
      const tracked = await queued2(ctx, label, opId, async () => {
        const compResp = await ctx.bridge.evalRaw({
          id: `${opId}_comp`,
          script: buildJsxCall("getComp", { comp_id: args.comp_id }),
          label: `${label} getComp`,
          mutates: false,
          toolName: "ae_track_point"
        });
        const comp = compResp.result;
        const fps = Number(comp.fps) > 0 ? Number(comp.fps) : 25;
        const start = args.start ?? Number(comp.workAreaStart);
        const end = args.end ?? Number(comp.workAreaStart) + Number(comp.workAreaDuration) - 1 / fps;
        const times2 = trackTimes(start, end, fps, MAX_TRACK_FRAMES);
        let tracker = null;
        let firstFrame = null;
        let scale = 1;
        const points2 = [];
        let lostAt2 = null;
        for (let i = 0; i < times2.length; i++) {
          const snap = await captureCompFrame({ ctx, opId, compId: args.comp_id, time: times2[i], frameIndex: i, framesDir, toolName: "ae_track_point" });
          const png = decodePngFile(snap.path);
          const gray = toGray(png);
          if (i === 0) {
            firstFrame = png;
            scale = png.width / Number(comp.width);
            tracker = new PointTracker(gray, args.point[0] * scale - 0.5, args.point[1] * scale - 0.5, {
              ...opts,
              patchSize: Math.max(9, Math.round(patchSize * scale) | 1),
              searchRadius: Math.max(2, Math.round(opts.searchRadius * scale))
            });
            points2.push({ time: times2[0], x: args.point[0], y: args.point[1], confidence: 1, adapted: false });
          } else {
            const s = tracker.step(gray);
            if (!s) {
              lostAt2 = { time: times2[i], frame: Math.round(times2[i] * fps) };
            } else {
              points2.push({ time: times2[i], x: (s.x + 0.5) / scale, y: (s.y + 0.5) / scale, confidence: s.confidence, adapted: s.adapted });
            }
          }
          fs21.rmSync(snap.path, { force: true });
          if (lostAt2) break;
        }
        return { comp, fps, start, end, times: times2, points: points2, lostAt: lostAt2, firstFrame, scale, contrast: tracker.contrast };
      });
      const { points, lostAt } = tracked;
      const previewPath = path21.join(framesDir, `track_c${args.comp_id}_${opId}.png`);
      fs21.writeFileSync(
        previewPath,
        encodePng(
          drawTrackPreview(
            tracked.firstFrame,
            points.map((p) => ({ x: p.x * tracked.scale - 0.5, y: p.y * tracked.scale - 0.5 })),
            patchSize * tracked.scale,
            lostAt !== null
          )
        )
      );
      const conf = points.slice(1).map((p) => p.confidence);
      const r2 = (v) => Math.round(v * 100) / 100;
      const result = {
        ok: true,
        comp_id: args.comp_id,
        start: r2(tracked.start),
        end: r2(tracked.end),
        frames_requested: tracked.times.length,
        frames_tracked: points.length,
        lost_at: lostAt,
        mean_confidence: conf.length ? r2(conf.reduce((a, b) => a + b, 0) / conf.length) : null,
        min_confidence: conf.length ? r2(Math.min(...conf)) : null,
        adapted_frames: points.filter((p) => p.adapted).length,
        pattern_contrast: r2(tracked.contrast),
        preview_path: previewPath,
        path: points.map((p) => [Math.round(p.time * 1e4) / 1e4, r2(p.x), r2(p.y), r2(p.confidence)]),
        path_format: "[time_s, x_px, y_px, confidence]"
      };
      if (!args.apply) return result;
      if (points.length < 2) {
        return { ...result, applied: false, message: "Fewer than two frames tracked, so no null was made." };
      }
      const expect = { project_path: args.apply.expect.project_path, comp_id: args.apply.expect.comp_id ?? args.comp_id };
      const times = points.map((p) => p.time);
      const values = points.map((p) => [p.x, p.y]);
      const write = await queued2(ctx, `${label} apply`, opId, async () => {
        const guard = await verifyTargetGuard(ctx, expect, opId);
        const checkpoint = await autoCheckpoint(ctx, guard, "ae_track_point");
        const made = await ctx.bridge.evalRaw({
          id: `${opId}_null`,
          script: buildJsxCall("createTrackNull", { comp_id: args.comp_id, name: args.apply.null_name, times, values, expect }),
          label: `${label} create null`,
          mutates: true,
          toolName: "ae_track_point"
        });
        const after = await ctx.bridge.evalRaw({
          id: `${opId}_after`,
          script: buildJsxCall("getKeyframeEase", {
            comp_id: args.comp_id,
            layer: { id: made.result.layer_id },
            path: ["ADBE Transform Group", "ADBE Position"]
          }),
          label: `${label} (after)`,
          mutates: false,
          toolName: "ae_track_point"
        });
        return { checkpoint, made: made.result, after: after.result };
      });
      const mismatches = [];
      const backward = times.length > 1 && times[0] > times[times.length - 1];
      const keysRaw = write.after?.keyframes ?? [];
      const keys = backward ? [...keysRaw].reverse() : keysRaw;
      if (write.made.numKeys !== points.length) {
        mismatches.push({ path: "numKeys", expected: points.length, actual: write.made.numKeys, message: "Key count differs from the tracked frames" });
      }
      keys.forEach((k, i) => compareValues(values[i].map(r2), k.value.slice(0, 2).map(r2), `keyframes[${i + 1}].value`, mismatches));
      const receipt = buildReceipt({ before: null, after: { null: write.made, keys_read: keys.length }, customMismatches: mismatches });
      return {
        ...result,
        applied: true,
        null: { id: write.made.layer_id, index: write.made.layer_index, name: write.made.name, keys: write.made.numKeys },
        checkpoint: write.checkpoint,
        receipt
      };
    }
  }
];

// src/tools/ext/index.ts
var extTools = [
  ...exploreTools,
  ...receiptsTools,
  ...animateTools,
  ...effectsTools,
  ...dataTools,
  ...reframeTools,
  ...assetsTools,
  ...framesTools,
  ...motionTools,
  ...askTools,
  ...skillsTools,
  ...briefTools,
  ...aerenderTools,
  ...dialogsTools,
  ...diagnosticsTools,
  ...panelsTools,
  ...trackTools,
  ...keyTools
];

// src/tools/quarantine.ts
var AeQuarantineStatusSchema = external_exports.object({});
var AeAcknowledgeSchema = external_exports.object({
  op_id: external_exports.string().min(1).describe("The quarantined operation ID (`op_id`) to acknowledge and clear."),
  note: external_exports.string().min(1).describe(
    "Explanation of what read tools showed about the operation's actual outcome in After Effects."
  )
});
var quarantineTools = [
  {
    name: "ae_quarantine_status",
    description: "Read the list of uncertain-outcome mutating operations currently in quarantine (`%LOCALAPPDATA%\\chroma-ae-mcp\\quarantine.json`). While any op is quarantined, all mutating tools refuse to run. " + AGENT_SAFETY_GUIDANCE,
    schema: AeQuarantineStatusSchema,
    handler: async (_args, ctx) => {
      const entries = ctx.quarantine.list();
      return {
        quarantined: entries.length > 0,
        count: entries.length,
        entries
      };
    }
  },
  {
    name: "ae_acknowledge",
    description: "Remove a timed-out operation from quarantine after calling `ae_status` and inspecting the project/comp state with read tools. " + AGENT_SAFETY_GUIDANCE,
    schema: AeAcknowledgeSchema,
    handler: async (args, ctx) => {
      return ctx.quarantine.acknowledge(args.op_id, args.note);
    }
  }
];

// src/tools/read.ts
var AeStatusSchema = external_exports.object({});
var AeGetProjectSchema = external_exports.object({
  folder_id: external_exports.number().int().optional().describe("Optional folder item ID to start traversal from (defaults to root)."),
  depth: external_exports.number().int().min(1).max(20).default(3).optional().describe("Maximum folder traversal depth (default: 3).")
});
var AeGetCompSchema = external_exports.object({
  comp_id: external_exports.number().int().describe("The CompItem ID to inspect.")
});
var AeGetLayerPropsSchema = external_exports.object({
  comp_id: external_exports.number().int().describe("The CompItem ID containing the layer."),
  layer: LayerSelectorSchema,
  path: external_exports.array(external_exports.string()).optional().describe(
    "Optional property group path (e.g. ['ADBE Transform Group', 'ADBE Opacity'] or ['Transform', 'Opacity'])."
  ),
  depth: external_exports.number().int().min(1).max(10).default(2).optional().describe("Depth of property tree traversal (default: 2).")
});
var readTools = [
  {
    name: "ae_status",
    description: "Read panel health (/health), AE version, current project path (or '<unsaved>'), dirty flag, active comp {id, name}, selected layers, and the server quarantine list. " + AGENT_SAFETY_GUIDANCE,
    schema: AeStatusSchema,
    handler: async (_args, ctx) => {
      const health = ctx.bridge.health ? await ctx.bridge.health() : { ok: true, transport: "panel" };
      const hostStatus = await ctx.bridge.callHost(
        "status",
        {},
        {
          label: "ae_status",
          mutates: false,
          toolName: "ae_status"
        }
      );
      return {
        health,
        ...hostStatus.result ?? {},
        quarantine: ctx.quarantine.list()
      };
    }
  },
  {
    name: "ae_get_project",
    description: "Read the project item tree: id, name, typeName, parent folder id; compositions include width, height, fps, duration; footage items include file path. " + AGENT_SAFETY_GUIDANCE,
    schema: AeGetProjectSchema,
    handler: async (args, ctx) => {
      const depth = args.depth ?? 3;
      const res = await ctx.bridge.callHost(
        "getProject",
        {
          folder_id: args.folder_id,
          depth
        },
        {
          label: "ae_get_project",
          mutates: false,
          toolName: "ae_get_project"
        }
      );
      return res.result;
    }
  },
  {
    name: "ae_get_comp",
    description: "Read composition settings, work area, and layers (index, name, id, type, in/out, parent, enabled, solo, locked, label, 3D, blending mode, track matte). " + AGENT_SAFETY_GUIDANCE,
    schema: AeGetCompSchema,
    handler: async (args, ctx) => {
      const res = await ctx.bridge.callHost(
        "getComp",
        { comp_id: args.comp_id },
        {
          label: `ae_get_comp(${args.comp_id})`,
          mutates: false,
          toolName: "ae_get_comp"
        }
      );
      return res.result;
    }
  },
  {
    name: "ae_get_layer_props",
    description: "Read a layer's property tree with matchName, name, value (serialised), numKeys, expression, and expressionEnabled. " + AGENT_SAFETY_GUIDANCE,
    schema: AeGetLayerPropsSchema,
    handler: async (args, ctx) => {
      const depth = args.depth ?? 2;
      const res = await ctx.bridge.callHost(
        "getLayerProps",
        {
          comp_id: args.comp_id,
          layer: args.layer,
          path: args.path,
          depth
        },
        {
          label: `ae_get_layer_props(${args.comp_id})`,
          mutates: false,
          toolName: "ae_get_layer_props"
        }
      );
      return res.result;
    }
  }
];

// src/tools/registry.ts
var ALL_TOOLS = [
  ...readTools,
  ...mutateTools,
  ...renderTools,
  ...quarantineTools,
  ...extTools
];

// src/mcp-rpc.ts
var TOOL_MAP = new Map(
  ALL_TOOLS.map((t) => [t.name, t])
);
var SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-06-18",
  "2025-03-26",
  "2024-11-05"
];
var DEFAULT_PROTOCOL_VERSION = "2025-06-18";
var SERVER_NAME = "chroma-ae-mcp";
var SERVER_VERSION = "0.2.0";
function makeErrorResponse(id, code, message, data) {
  const error = { code, message };
  if (data !== void 0) {
    error.data = data;
  }
  return {
    jsonrpc: "2.0",
    id,
    error
  };
}
function isPlainObject(val) {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}
async function handleSingleRpc(message, ctx) {
  if (!isPlainObject(message)) {
    return makeErrorResponse(null, -32600, "Invalid Request");
  }
  const hasId = "id" in message && message.id !== void 0;
  const rawId = message.id;
  const id = typeof rawId === "string" || typeof rawId === "number" || rawId === null ? rawId : null;
  const method = message.method;
  if (typeof method !== "string" || method.length === 0) {
    return makeErrorResponse(id, -32600, "Invalid Request: missing method");
  }
  if (!hasId) {
    return null;
  }
  const rawParams = message.params;
  if (rawParams !== void 0 && !isPlainObject(rawParams)) {
    return makeErrorResponse(
      id,
      -32602,
      "Invalid params: expected an object"
    );
  }
  const params = rawParams ?? {};
  switch (method) {
    case "initialize": {
      const clientVersion = typeof params.protocolVersion === "string" ? params.protocolVersion : void 0;
      const protocolVersion = clientVersion && SUPPORTED_PROTOCOL_VERSIONS.includes(
        clientVersion
      ) ? clientVersion : DEFAULT_PROTOCOL_VERSION;
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: {
            tools: {
              listChanged: false
            }
          },
          serverInfo: {
            name: SERVER_NAME,
            version: SERVER_VERSION
          }
        }
      };
    }
    case "ping": {
      return {
        jsonrpc: "2.0",
        id,
        result: {}
      };
    }
    case "tools/list": {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: ALL_TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: zodToJsonSchema(t.schema)
          }))
        }
      };
    }
    case "tools/call": {
      const toolName = params.name;
      if (typeof toolName !== "string" || toolName.length === 0) {
        return makeErrorResponse(
          id,
          -32602,
          "Invalid params: tools/call requires a string `name`"
        );
      }
      const rawArgs = params.arguments;
      if (rawArgs !== void 0 && !isPlainObject(rawArgs)) {
        return makeErrorResponse(
          id,
          -32602,
          "Invalid params: `arguments` must be an object"
        );
      }
      const tool = TOOL_MAP.get(toolName);
      if (!tool) {
        return {
          jsonrpc: "2.0",
          id,
          result: formatToolError(new Error(`Unknown tool: ${toolName}`))
        };
      }
      const parsed = tool.schema.safeParse(rawArgs ?? {});
      if (!parsed.success) {
        return {
          jsonrpc: "2.0",
          id,
          result: formatToolError(
            new Error(
              `Invalid arguments for ${toolName}: ${parsed.error.issues.map(
                (i) => `${i.path.join(".") || "<root>"}: ${i.message}`
              ).join("; ")}`
            )
          )
        };
      }
      try {
        const output = await tool.handler(parsed.data, ctx);
        return {
          jsonrpc: "2.0",
          id,
          result: formatToolResponse(output)
        };
      } catch (err) {
        return {
          jsonrpc: "2.0",
          id,
          result: formatToolError(err)
        };
      }
    }
    default: {
      return makeErrorResponse(
        id,
        -32601,
        `Method not found: ${method}`
      );
    }
  }
}
async function handleRpc(message, ctx) {
  let parsed = message;
  if (typeof message === "string") {
    try {
      parsed = JSON.parse(message);
    } catch {
      return makeErrorResponse(null, -32700, "Parse error");
    }
  }
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      return makeErrorResponse(null, -32600, "Invalid Request: empty batch");
    }
    const results = [];
    for (const item of parsed) {
      const res = await handleSingleRpc(item, ctx);
      if (res !== null) {
        results.push(res);
      }
    }
    return results.length > 0 ? results : null;
  }
  return await handleSingleRpc(parsed, ctx);
}

// src/panel-host.ts
var crypto5 = __toESM(require("node:crypto"), 1);
var DESCRIBE_DIALOGS_BUDGET_MS = 4e3;
var PanelTimeoutSignal = class extends Error {
  constructor() {
    super("PanelHost evalScript timed out");
    this.name = "PanelTimeoutSignal";
  }
};
var PanelHost = class {
  evalScript;
  queue;
  quarantine;
  defaultTimeoutMs;
  describeDialogs;
  constructor(optsOrFn, extraOpts) {
    if (typeof optsOrFn === "function") {
      this.evalScript = optsOrFn;
      this.queue = extraOpts?.queue;
      this.quarantine = extraOpts?.quarantine;
      this.defaultTimeoutMs = extraOpts?.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
      this.describeDialogs = extraOpts?.describeDialogs;
    } else {
      this.evalScript = optsOrFn.evalScript;
      this.queue = optsOrFn.queue;
      this.quarantine = optsOrFn.quarantine;
      this.defaultTimeoutMs = optsOrFn.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
      this.describeDialogs = optsOrFn.describeDialogs;
    }
  }
  newOpId() {
    return `op_${Date.now()}_${crypto5.randomBytes(4).toString("hex")}`;
  }
  /**
   * Calls the panel's evalScript queue, racing against a timeout via setTimeout.
   * On timeout, throws kind:"timeout", quarantines the op if mutates:true,
   * and NEVER cancels the underlying evalScript promise.
   */
  async evalRaw(params) {
    const timeoutMs = params.timeoutMs ?? this.defaultTimeoutMs;
    const startedAt = Date.now();
    let rawPromise;
    noteOpStarted(params.id);
    try {
      rawPromise = Promise.resolve(
        this.evalScript(params.script, params.label)
      );
    } catch (syncErr) {
      throw new BridgeError({
        kind: "evalscript_error",
        op_id: params.id,
        message: syncErr instanceof Error ? syncErr.message : String(syncErr)
      });
    }
    rawPromise.then(
      () => noteOpFinished(params.id),
      () => noteOpFinished(params.id)
    );
    let timer;
    const timeoutPromise = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new PanelTimeoutSignal());
      }, timeoutMs);
    });
    let payload;
    try {
      payload = await Promise.race([rawPromise, timeoutPromise]);
    } catch (err) {
      if (err instanceof PanelTimeoutSignal) {
        if (params.mutates && this.quarantine) {
          this.quarantine.add({
            op_id: params.id,
            tool: params.toolName ?? params.label,
            label: params.label,
            reason: `Timed out after ${Math.round(
              timeoutMs / 1e3
            )}s; outcome unknown.`
          });
        }
        let blocking = [];
        if (this.describeDialogs) {
          let budget;
          try {
            blocking = await Promise.race([
              this.describeDialogs(),
              new Promise((resolve2) => {
                budget = setTimeout(() => resolve2([]), DESCRIBE_DIALOGS_BUDGET_MS);
              })
            ]);
          } catch {
            blocking = [];
          } finally {
            if (budget !== void 0) clearTimeout(budget);
          }
        }
        const dialogNote = blocking.length > 0 ? ` AE is showing ${blocking.length} popup(s): ` + blocking.map((d) => {
          const x = d;
          const btns = (x.buttons ?? []).map((b) => b.name).filter(Boolean).join(" | ");
          return `"${x.title ?? "untitled"}"${btns ? ` [${btns}]` : ""}`;
        }).join("; ") + ". Read them with ae_dialogs; answer with ae_dialog_respond only under Jay's rules." : "";
        throw new BridgeError({
          kind: "timeout",
          op_id: params.id,
          actual: blocking.length > 0 ? { blocking_dialogs: blocking } : void 0,
          message: `Operation "${params.label}" (${params.id}) timed out after ${Math.round(
            timeoutMs / 1e3
          )}s: outcome unknown. Do NOT resend this request \u2014 it may still be running or have completed in After Effects.` + (params.mutates ? ` Op "${params.id}" has been placed in quarantine; call ae_status, inspect state with read tools, then ae_acknowledge.` : "") + dialogNote
        });
      }
      if (err instanceof BridgeError) {
        throw err;
      }
      throw new BridgeError({
        kind: "evalscript_error",
        op_id: params.id,
        message: err instanceof Error ? err.message : String(err)
      });
    } finally {
      if (timer !== void 0) {
        clearTimeout(timer);
      }
    }
    if (!payload || typeof payload !== "object") {
      throw new BridgeError({
        kind: "evalscript_error",
        op_id: params.id,
        message: "Panel evalScript returned an invalid response envelope"
      });
    }
    if (!payload.ok) {
      const errObj = payload.error ?? {
        message: "Unknown ExtendScript error",
        kind: "evalscript_error"
      };
      const mappedKind = normalizeErrorKind(errObj.kind);
      throw new BridgeError({
        kind: mappedKind,
        op_id: params.id,
        message: errObj.message || "Unknown ExtendScript error",
        line: errObj.line,
        actual: errObj.actual,
        expected: errObj.expected
      });
    }
    return {
      id: params.id,
      ok: true,
      result: payload.result,
      durationMs: typeof payload.durationMs === "number" ? payload.durationMs : Date.now() - startedAt
    };
  }
  /**
   * Executes a host function `__chromaAe.<fn>(args)` through the single-writer queue.
   */
  async callHost(fn, args, opts) {
    if (opts.mutates && this.quarantine) {
      this.quarantine.assertClear();
    }
    const opId = opts.opId ?? this.newOpId();
    const script = buildJsxCall(fn, args);
    const runEval = async () => {
      const resp = await this.evalRaw({
        id: opId,
        script,
        label: opts.label,
        timeoutMs: opts.timeoutMs,
        mutates: opts.mutates,
        toolName: opts.toolName
      });
      return { id: resp.id, result: resp.result, durationMs: resp.durationMs };
    };
    if (!this.queue) {
      return await runEval();
    }
    try {
      return await this.queue.run(opts.label, runEval);
    } catch (err) {
      if (err instanceof QueueWaitError) {
        throw new BridgeError({
          kind: "queued",
          op_id: opId,
          message: err.message
        });
      }
      throw err;
    }
  }
};

// src/panel-entry.ts
function sendResponse(res, statusCode, headers, body) {
  if (res.writableEnded) return;
  res.statusCode = statusCode;
  if (typeof res.setHeader === "function") {
    for (const [k, v] of Object.entries(headers)) {
      res.setHeader(k, v);
    }
  } else if (typeof res.writeHead === "function") {
    res.writeHead(statusCode, headers);
  }
  res.end(body);
}
function readRequestBody(req) {
  return new Promise((resolve2, reject) => {
    if (typeof req.on !== "function") {
      resolve2("");
      return;
    }
    const chunks = [];
    req.on("data", (chunk) => {
      chunks.push(
        typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk
      );
    });
    req.on("end", () => {
      resolve2(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (err) => {
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}
function createPanelMcp(opts) {
  const resolvedDataDir = opts.dataDir ?? defaultDataDir();
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(
    path22.join(resolvedDataDir, "quarantine.json")
  );
  const host = new PanelHost({
    evalScript: opts.evalScript,
    queue,
    quarantine,
    describeDialogs: describeBlockingDialogs
  });
  const ctx = {
    bridge: host,
    queue,
    quarantine,
    cep: opts.cep,
    settings: new SettingsStore(path22.join(resolvedDataDir, "settings.json")),
    asks: new AskStore(),
    dataDir: resolvedDataDir,
    serviceInfo: opts.serviceInfo
  };
  const log = opts.log;
  const assetWatcher = new AssetWatcher(ctx, { log });
  if (opts.watchAssets !== false) assetWatcher.start();
  async function handleHttp(req, res, bodyText) {
    const method = (req.method ?? "GET").toUpperCase();
    if (method !== "POST") {
      sendResponse(
        res,
        405,
        {
          Allow: "POST",
          "Content-Type": "application/json"
        },
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32600,
            message: "Method Not Allowed. Use POST /mcp."
          }
        })
      );
      return;
    }
    let rawBody;
    if (typeof bodyText === "string") {
      rawBody = bodyText;
    } else {
      try {
        rawBody = await readRequestBody(req);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (log) log("err", `MCP HTTP body read error: ${msg}`);
        sendResponse(
          res,
          400,
          { "Content-Type": "application/json" },
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: {
              code: -32700,
              message: `Parse error: ${msg}`
            }
          })
        );
        return;
      }
    }
    let parsed;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      if (log) log("warn", "MCP received invalid JSON body");
      sendResponse(
        res,
        200,
        { "Content-Type": "application/json" },
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32700,
            message: "Parse error"
          }
        })
      );
      return;
    }
    const rpcResponse = await handleRpc(parsed, ctx);
    if (rpcResponse === null || Array.isArray(rpcResponse) && rpcResponse.length === 0) {
      if (!res.writableEnded) {
        res.statusCode = 202;
        res.end("");
      }
      return;
    }
    sendResponse(
      res,
      200,
      { "Content-Type": "application/json" },
      JSON.stringify(rpcResponse)
    );
  }
  return {
    handleHttp,
    ctx,
    host,
    asks: ctx.asks,
    assetWatcher,
    saveDiagnostics: () => writeDiagnostics(ctx, opts.serviceInfo?.())
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  PanelHost,
  createPanelMcp,
  handleRpc
});
