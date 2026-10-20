// Draws the state map onto a canvas and handles zoom, pan, hover and click.

class MapRenderer {
  constructor(container, canvas, pixels, callbacks) {
    this.container = container;
    this.canvas = canvas;
    this.pixels = pixels;
    this.onHover = callbacks.onHover;
    this.onClick = callbacks.onClick;

    canvas.width = pixels.width;
    canvas.height = pixels.height;
    this.ctx = canvas.getContext("2d");
    this.image = this.ctx.createImageData(pixels.width, pixels.height);
    this.buf32 = new Uint32Array(this.image.data.buffer);

    this.zoom = 1;
    this.minZoom = 0.05;
    this.maxZoom = 16;
    this.bindEvents();
  }

  // colours: Uint32Array indexed by state index (0 = no state), packed as 0xAABBGGRR.
  // borderColours: same, used for border pixels of each state.
  // stripeColours: same; when non-zero the state is drawn with diagonal stripes of this colour.
  draw(colours, borderColours, stripeColours) {
    MapRenderer.paint(this.pixels, this.buf32, colours, borderColours, stripeColours, 2);
    this.ctx.putImageData(this.image, 0, 0);
  }

  // Fill a pixel buffer (Uint32Array, one entry per map pixel) with state colours.
  // Stripes are 2^stripeShift pixels wide.
  static paint(pixels, buf, colours, borderColours, stripeColours, stripeShift) {
    const { width, height, stateIndex, border } = pixels;
    for (let y = 0, p = 0; y < height; y++) {
      for (let x = 0; x < width; x++, p++) {
        const s = stateIndex[p];
        if (border[p]) buf[p] = borderColours[s];
        else if (stripeColours[s] && ((x + y) >> stripeShift) & 1) buf[p] = stripeColours[s];
        else buf[p] = colours[s];
      }
    }
  }

  setZoom(z, anchorClientX, anchorClientY) {
    z = Math.min(this.maxZoom, Math.max(this.minZoom, z));
    const rect = this.container.getBoundingClientRect();
    const ax = anchorClientX ?? rect.left + rect.width / 2;
    const ay = anchorClientY ?? rect.top + rect.height / 2;
    // Keep the image point under the anchor in place
    const imgX = (this.container.scrollLeft + ax - rect.left) / this.zoom;
    const imgY = (this.container.scrollTop + ay - rect.top) / this.zoom;
    this.zoom = z;
    this.canvas.style.width = `${this.pixels.width * z}px`;
    this.canvas.style.height = `${this.pixels.height * z}px`;
    this.container.scrollLeft = imgX * z - (ax - rect.left);
    this.container.scrollTop = imgY * z - (ay - rect.top);
  }

  fit() {
    const rect = this.container.getBoundingClientRect();
    const z = Math.min(rect.width / this.pixels.width, rect.height / this.pixels.height);
    this.minZoom = Math.min(z, 1) * 0.5;
    this.setZoom(z);
    this.container.scrollLeft = 0;
    this.container.scrollTop = 0;
  }

  // Zoom so a bounding box fills most of the view, centred.
  focus(bbox) {
    if (!bbox) return;
    const rect = this.container.getBoundingClientRect();
    const w = bbox.x1 - bbox.x0 + 1;
    const h = bbox.y1 - bbox.y0 + 1;
    const z = Math.min(this.maxZoom, (rect.width * 0.5) / w, (rect.height * 0.5) / h);
    this.setZoom(Math.max(z, this.zoom > z ? z : this.zoom));
    const cx = ((bbox.x0 + bbox.x1) / 2) * this.zoom;
    const cy = ((bbox.y0 + bbox.y1) / 2) * this.zoom;
    this.container.scrollLeft = cx - rect.width / 2;
    this.container.scrollTop = cy - rect.height / 2;
  }

  stateAt(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const x = Math.floor((clientX - rect.left) / this.zoom);
    const y = Math.floor((clientY - rect.top) / this.zoom);
    if (x < 0 || y < 0 || x >= this.pixels.width || y >= this.pixels.height) return 0;
    return this.pixels.stateIndex[y * this.pixels.width + x];
  }

  bindEvents() {
    const c = this.container;
    let drag = null;

    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
      this.setZoom(this.zoom * factor, e.clientX, e.clientY);
    }, { passive: false });

    c.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, sl: c.scrollLeft, st: c.scrollTop, moved: false };
      c.setPointerCapture(e.pointerId);
    });

    c.addEventListener("pointermove", (e) => {
      if (drag) {
        const dx = e.clientX - drag.x;
        const dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
        if (drag.moved) {
          c.scrollLeft = drag.sl - dx;
          c.scrollTop = drag.st - dy;
          c.classList.add("dragging");
          return;
        }
      }
      this.onHover(this.stateAt(e.clientX, e.clientY), e.clientX, e.clientY);
    });

    c.addEventListener("pointerup", (e) => {
      if (drag && !drag.moved) this.onClick(this.stateAt(e.clientX, e.clientY));
      drag = null;
      c.classList.remove("dragging");
    });

    c.addEventListener("pointerleave", () => this.onHover(0));
  }
}
