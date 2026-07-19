// @ts-check
(function () {
  /** @type {ReturnType<typeof acquireVsCodeApi>} */
  const vscode = acquireVsCodeApi();

  const textarea = /** @type {HTMLTextAreaElement} */ (
    document.getElementById('gltf-input')
  );
  const container3d = /** @type {HTMLDivElement} */ (
    document.getElementById('gltf-container-3d')
  );
  const errorEl = /** @type {HTMLDivElement} */ (
    document.getElementById('gltf-error')
  );
  const noteEl = /** @type {HTMLDivElement} */ (
    document.getElementById('gltf-note')
  );
  const containerEl = /** @type {HTMLDivElement} */ (
    document.getElementById('gltf-container')
  );
  const divider = /** @type {HTMLDivElement} */ (
    document.getElementById('gltf-divider')
  );

  const btnFit = document.getElementById('gltf-fit');
  const btnReset = document.getElementById('gltf-reset');
  const btnWireframe = document.getElementById('gltf-wireframe');
  const btnGrid = document.getElementById('gltf-grid');
  const btnUpdate = document.getElementById('gltf-update');

  // @ts-ignore - ThreeBundle loaded globally from three-bundle.js
  const { THREE, GLTFLoader, OrbitControls, RoomEnvironment } = ThreeBundle;
  // @ts-ignore - GltfViewerMath loaded globally from gltfViewerMath.js
  const { computeFraming, extractJsonErrorLine } = GltfViewerMath;

  /** Static per-document base URI every relative glTF `uri` resolves against. */
  const resourceBase = container3d.dataset.resourceBase || '';

  // ================================================
  // three.js scene — created ONCE per webview lifetime. Camera position,
  // orientation and OrbitControls target are never reset on a reload; that
  // is what makes camera preservation across edits structural rather than
  // something that has to be remembered/restored per render.
  // ================================================
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  container3d.appendChild(renderer.domElement);

  const scene = new THREE.Scene(); // no background — alpha lets the theme bg show through
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
  camera.position.set(3, 2, 5);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  // A glTF with no lights of its own renders solid black — PBR materials
  // need an environment to reflect/shade against.
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  scene.add(new THREE.AmbientLight(0xffffff, 0.15));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.6);
  dirLight.position.set(3, 5, 2);
  scene.add(dirLight);

  // Grid/axes live directly on `scene`, never inside `currentRoot` — keeping
  // them out of the model subtree is what keeps them out of the framing
  // Box3 (frameModel() computes bounds from currentRoot alone).
  const gridHelper = new THREE.GridHelper(10, 10);
  const axesHelper = new THREE.AxesHelper(2);
  let gridVisible = false;

  let wireframeOn = false;
  let currentRoot = /** @type {any} */ (null);
  let hasAutoFramed = false;
  /** Bumped on every successful setModel() — lets tests (via __gltfDebug)
   *  detect "a reload just completed" without depending on triangle counts
   *  or other content-shaped signals that don't change between reloads of
   *  semantically-different-but-visually-identical models. */
  let loadCount = 0;

  // A dedicated LoadingManager (rather than THREE.DefaultLoadingManager)
  // keeps this webview's resource errors from ever being observed by/
  // interfering with any other loader that might exist on the page.
  const manager = new THREE.LoadingManager();
  /** URL of the most recent resource-load failure, relative to resourceBase. */
  let lastResourceError = /** @type {string | null} */ (null);
  manager.onError = (url) => {
    lastResourceError =
      typeof url === 'string' && url.indexOf(resourceBase) === 0
        ? url.slice(resourceBase.length)
        : url;
  };
  const loader = new GLTFLoader(manager);

  // ================================================
  // GPU disposal — three.js never GCs GPU-side resources on its own; without
  // walking the tree on every swap/supersede, each reload leaks geometries,
  // textures and materials.
  // ================================================
  function disposeMaterial(m) {
    for (const v of Object.values(m)) {
      // @ts-ignore - duck-typed texture check, matches three.js convention
      if (v && v.isTexture) v.dispose();
    }
    m.dispose();
  }

  function disposeObject3D(root) {
    root.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        Array.isArray(o.material) ? o.material.forEach(disposeMaterial) : disposeMaterial(o.material);
      }
      if (o.isSkinnedMesh && o.skeleton) o.skeleton.dispose();
    });
  }

  // ================================================
  // Model swap + framing
  // ================================================
  function applyWireframe() {
    if (!currentRoot) return;
    currentRoot.traverse((o) => {
      if (!o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if ('wireframe' in m) m.wireframe = wireframeOn;
      }
    });
  }

  function applyGrid() {
    if (gridVisible) {
      scene.add(gridHelper);
      scene.add(axesHelper);
    } else {
      scene.remove(gridHelper);
      scene.remove(axesHelper);
    }
  }

  /** Recompute camera framing for `root`'s current bounds. */
  function frameModel(root) {
    const box = new THREE.Box3().setFromObject(root);
    const framing = computeFraming(
      [box.min.x, box.min.y, box.min.z],
      [box.max.x, box.max.y, box.max.z],
      camera.fov
    );
    if (framing.isEmpty) return; // don't NaN the camera on a degenerate scene
    camera.position.set(framing.position[0], framing.position[1], framing.position[2]);
    camera.near = framing.near;
    camera.far = framing.far;
    camera.updateProjectionMatrix();
    controls.target.set(framing.center[0], framing.center[1], framing.center[2]);
    controls.update();
  }

  /**
   * Swap in a newly loaded model. Only the model subtree is replaced —
   * renderer/scene/camera/controls persist for the webview's whole lifetime,
   * which is what preserves the viewport (camera position/orientation,
   * OrbitControls target) across every reload by construction.
   */
  function setModel(newRoot) {
    if (currentRoot) {
      scene.remove(currentRoot);
      disposeObject3D(currentRoot);
    }
    currentRoot = newRoot;
    scene.add(newRoot);
    loadCount++;
    applyWireframe();
    if (!hasAutoFramed) {
      frameModel(newRoot);
      controls.saveState();
      hasAutoFramed = true;
    }
  }

  // ================================================
  // Error banner / passive note
  // ================================================
  function showError(message) {
    errorEl.textContent = message;
    errorEl.hidden = false;
  }
  function hideError() {
    errorEl.hidden = true;
    errorEl.textContent = '';
  }
  function showNote(message) {
    noteEl.textContent = message;
    noteEl.hidden = false;
  }
  function hideNote() {
    noteEl.hidden = true;
  }

  // ================================================
  // Render pipeline: JSON.parse validity gate -> semantic-identity skip ->
  // GLTFLoader.parse -> stale-render guard.
  // ================================================
  const SIZE_GATE = 2_000_000;
  let renderSeq = 0;
  /** JSON.stringify() of the last object actually handed to GLTFLoader — lets
   *  a pure reformat (different text, identical parsed value) skip the
   *  reload entirely. */
  let lastRenderedJson = /** @type {string | null} */ (null);

  /**
   * @param {string} source
   * @param {{force?: boolean}} [opts] force bypasses both the size gate and
   *   the semantic-identity skip — the Update button always reloads.
   */
  function doRender(source, opts) {
    const force = !!(opts && opts.force);
    const seq = ++renderSeq;

    let parsed;
    try {
      parsed = JSON.parse(source);
    } catch (err) {
      const line = extractJsonErrorLine(err, source);
      showError('Invalid JSON' + (line !== null ? ' (line ' + line + ')' : '') + ': ' + (err && err.message ? err.message : String(err)));
      return; // keep-last-good: currentRoot / scene are left untouched
    }

    const json = JSON.stringify(parsed);
    if (!force && json === lastRenderedJson) {
      // Semantically identical to what's already loaded (e.g. a pure
      // reformat) — clear any stale error banner but skip the reload.
      hideError();
      return;
    }
    lastRenderedJson = json;
    lastResourceError = null;

    loader.parse(
      parsed,
      resourceBase,
      (gltf) => {
        if (seq !== renderSeq) {
          // A newer render superseded this one while parse() was async —
          // the result still holds GPU resources, so dispose it immediately
          // rather than just dropping the reference.
          disposeObject3D(gltf.scene);
          return;
        }
        setModel(gltf.scene);
        hideError();
      },
      (err) => {
        if (seq !== renderSeq) return;
        const detail = lastResourceError
          ? 'Missing resource: ' + lastResourceError
          : (err && err.message) || String(err);
        showError('Failed to load glTF: ' + detail);
      }
    );
  }

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let renderDebounce;
  let autoRenderDisabled = false;

  /** Debounced (500ms), validity/size-gated render — the live-typing path. */
  function scheduleGltfRender(source) {
    clearTimeout(renderDebounce);
    if (source.length > SIZE_GATE) {
      autoRenderDisabled = true;
      showNote('Auto-update disabled for large files — press Update.');
      return;
    }
    if (autoRenderDisabled) {
      autoRenderDisabled = false;
      hideNote();
    }
    renderDebounce = setTimeout(() => doRender(source), 500);
  }

  /** Immediate, forced render — the Update button's path. */
  function forceGltfRender(source) {
    clearTimeout(renderDebounce);
    autoRenderDisabled = false;
    hideNote();
    doRender(source, { force: true });
  }

  // ================================================
  // Document sync with the extension host.
  //
  // Copied verbatim from mermaidEditor.js's design (see its comments for the
  // full rationale) — the only difference is that the render call fed here
  // is scheduleGltfRender instead of renderDiagram.
  // ================================================

  // Track whether the current textarea update originated from the extension
  // host (an 'update' message), so the 'input' handler doesn't treat the
  // resulting DOM mutation as a local edit and echo it straight back.
  let isExternalUpdate = false;

  // The source most recently posted to the extension host, plus whether a
  // debounced local edit is still waiting to be posted, plus how many posted
  // edits haven't been acked yet. Together these let the 'update' handler
  // recognize echoes of our own edits and avoid clobbering local typing that
  // is still in flight to the host.
  let lastSentEditText = null;
  let localEditPending = false;
  let editsInFlight = 0;

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let editDebounce;

  // The extension host's document text may use CRLF line endings while the
  // textarea (an HTML control) always normalizes to LF internally. Work in
  // LF throughout the webview and let the host re-expand to the document's
  // real EOL on the way back in (mirrors gltfEditorProvider.ts's 'edit'
  // handler). Without this, `text === lastSentEditText` below would never
  // match for CRLF documents and every one of our own edits would look like
  // an external change, causing the textarea to be clobbered and the caret
  // to jump on every keystroke.
  function normalizeEol(text) {
    return text.replace(/\r\n/g, '\n');
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'editAck') {
      editsInFlight = Math.max(0, editsInFlight - 1);
      return;
    }
    if (message.type === 'update') {
      const text = normalizeEol(message.text);
      const isEcho = text === textarea.value || text === lastSentEditText;
      if (isEcho) {
        return;
      }
      // A newer local edit is still in flight to the host (debounced, or
      // sent but not yet acked) — applying this now-stale host text would
      // clobber what the user just typed. Drop it; once the in-flight edit
      // is acked, the document already matches what we're showing.
      if (localEditPending || editsInFlight > 0) {
        return;
      }
      isExternalUpdate = true;
      const selStart = textarea.selectionStart;
      const selEnd = textarea.selectionEnd;
      textarea.value = text;
      textarea.selectionStart = Math.min(selStart, text.length);
      textarea.selectionEnd = Math.min(selEnd, text.length);
      isExternalUpdate = false;
      scheduleGltfRender(text);
    }
  });

  textarea.addEventListener('input', () => {
    if (isExternalUpdate) {
      return;
    }
    const text = textarea.value;

    scheduleGltfRender(text);

    localEditPending = true;
    clearTimeout(editDebounce);
    editDebounce = setTimeout(() => {
      localEditPending = false;
      editsInFlight++;
      lastSentEditText = text;
      vscode.postMessage({ type: 'edit', text: text });
    }, 150);
  });

  // ================================================
  // Toolbar
  // ================================================
  btnFit?.addEventListener('click', () => {
    if (!currentRoot) return;
    frameModel(currentRoot);
    controls.saveState();
  });

  btnReset?.addEventListener('click', () => {
    controls.reset();
  });

  btnWireframe?.addEventListener('click', () => {
    wireframeOn = !wireframeOn;
    btnWireframe.classList.toggle('active', wireframeOn);
    btnWireframe.setAttribute('aria-pressed', String(wireframeOn));
    applyWireframe();
  });

  btnGrid?.addEventListener('click', () => {
    gridVisible = !gridVisible;
    btnGrid.classList.toggle('active', gridVisible);
    btnGrid.setAttribute('aria-pressed', String(gridVisible));
    applyGrid();
  });

  btnUpdate?.addEventListener('click', () => {
    forceGltfRender(textarea.value);
  });

  document.getElementById('btn-about')?.addEventListener('click', () =>
    vscode.postMessage({ type: 'showAbout' })
  );

  // ================================================
  // Resize
  // ================================================
  const resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const { width, height } = entry.contentRect;
      if (width <= 0 || height <= 0) continue;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    }
  });
  resizeObserver.observe(container3d);

  // ================================================
  // Render loop lifecycle — the panel uses retainContextWhenHidden: true, so
  // an ungated loop would keep burning GPU cycles forever while hidden.
  // ================================================
  let running = false;
  function tick() {
    controls.update();
    renderer.render(scene, camera);
  }
  function startLoop() {
    if (!running) {
      running = true;
      renderer.setAnimationLoop(tick);
    }
  }
  function stopLoop() {
    running = false;
    renderer.setAnimationLoop(null);
  }
  document.addEventListener('visibilitychange', () =>
    document.visibilityState === 'visible' ? startLoop() : stopLoop()
  );
  startLoop();

  // ================================================
  // Draggable divider for pane resizing (same behavior as the mermaid editor)
  // ================================================
  let isDragging = false;

  divider.addEventListener('mousedown', (e) => {
    isDragging = true;
    divider.classList.add('dragging');
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const containerRect = containerEl.getBoundingClientRect();
    const editorPane = document.getElementById('gltf-editor-pane');
    const previewPane = document.getElementById('gltf-preview-pane');
    if (!editorPane || !previewPane) return;

    const offset = e.clientX - containerRect.left;
    const percentage = Math.max(20, Math.min(80, (offset / containerRect.width) * 100));

    editorPane.style.flex = 'none';
    editorPane.style.width = percentage + '%';
    previewPane.style.flex = 'none';
    previewPane.style.width = (100 - percentage) + '%';
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      divider.classList.remove('dragging');
    }
  });

  // ================================================
  // Test-only hook (harmless outside the Playwright harness / dev tools):
  // lets assertions read camera/controls/renderer state without reaching
  // into module-private closures.
  // ================================================
  // @ts-ignore
  window.__gltfDebug = {
    camera,
    controls,
    renderer,
    getState() {
      return {
        cameraPosition: camera.position.toArray(),
        controlsTarget: controls.target.toArray(),
        hasAutoFramed,
        loadCount,
        wireframeOn,
        gridVisible,
        geometries: renderer.info.memory.geometries,
        textures: renderer.info.memory.textures,
        triangles: renderer.info.render.triangles,
      };
    },
  };

  vscode.postMessage({ type: 'ready' });
  // Initial render happens when the first 'update' message arrives.
})();
