/* Genuine Draw landing page: Three.js scenes, GSAP scroll story, live scratch demo. */
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const mobile = matchMedia('(max-width: 860px)').matches;
  const hasGsap = !!(window.gsap && window.ScrollTrigger);
  if (reduce) document.documentElement.classList.add('reduce');
  if (!hasGsap) document.documentElement.classList.add('no-js');
  $('#yr').textContent = new Date().getFullYear();
  const rd = $('#rDate'); if (rd) rd.textContent = new Date().toLocaleDateString('en-GB');

  // ---------------------------------------------------------------- smooth scroll
  let lenis = null;
  if (!reduce && window.Lenis && hasGsap) {
    lenis = new Lenis({ lerp: 0.1, smoothWheel: true });
    lenis.on('scroll', ScrollTrigger.update);
    gsap.ticker.add(t => lenis.raf(t * 1000));
    gsap.ticker.lagSmoothing(0);
  }
  $$('a[href^="#"]').forEach(a => a.addEventListener('click', e => {
    const id = a.getAttribute('href');
    const target = id.length > 1 && $(id);
    if (!target) return;
    e.preventDefault();
    if (lenis) lenis.scrollTo(target, { offset: -60, duration: 1.4 });
    else target.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth' });
  }));
  const nav = $('#nav');
  const onScroll = () => nav.classList.toggle('solid', scrollY > 40);
  addEventListener('scroll', onScroll, { passive: true }); onScroll();

  // ---------------------------------------------------------------- Three.js scenes
  function webglOk() {
    try { const c = document.createElement('canvas'); return !!(window.WebGLRenderingContext && (c.getContext('webgl') || c.getContext('experimental-webgl'))); }
    catch { return false; }
  }
  const canvasTex = (w, h, draw) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(c); t.anisotropy = 4; t.encoding = THREE.sRGBEncoding;
    return t;
  };
  // A soft studio environment so the gold actually shines.
  function envMap(renderer) {
    const tex = canvasTex(1024, 512, (g, w, h) => {
      const bg = g.createLinearGradient(0, 0, 0, h);
      bg.addColorStop(0, '#2B3F78'); bg.addColorStop(.5, '#0E1836'); bg.addColorStop(1, '#05091A');
      g.fillStyle = bg; g.fillRect(0, 0, w, h);
      const spot = (x, y, r, c) => { const s = g.createRadialGradient(x, y, 0, x, y, r); s.addColorStop(0, c); s.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = s; g.fillRect(0, 0, w, h); };
      spot(w * .2, h * .3, 160, 'rgba(255,236,190,1)');
      spot(w * .62, h * .22, 220, 'rgba(255,214,140,.95)');
      spot(w * .85, h * .55, 140, 'rgba(160,190,255,.8)');
      spot(w * .45, h * .8, 200, 'rgba(255,190,110,.5)');
      g.fillStyle = 'rgba(255,255,255,.9)'; g.fillRect(w * .05, h * .12, w * .12, 18); g.fillRect(w * .7, h * .1, w * .1, 14);
    });
    tex.mapping = THREE.EquirectangularReflectionMapping;
    const pm = new THREE.PMREMGenerator(renderer);
    const env = pm.fromEquirectangular(tex).texture;
    tex.dispose(); pm.dispose();
    return env;
  }
  function shieldShape(s = 1) {
    const p = new THREE.Shape();
    p.moveTo(0, 1.18 * s);
    p.bezierCurveTo(.35 * s, 1.05 * s, .7 * s, 1.02 * s, 1 * s, 1.08 * s);
    p.lineTo(1 * s, .15 * s);
    p.bezierCurveTo(1 * s, -.55 * s, .55 * s, -.98 * s, 0, -1.26 * s);
    p.bezierCurveTo(-.55 * s, -.98 * s, -1 * s, -.55 * s, -1 * s, .15 * s);
    p.lineTo(-1 * s, 1.08 * s);
    p.bezierCurveTo(-.7 * s, 1.02 * s, -.35 * s, 1.05 * s, 0, 1.18 * s);
    return p;
  }
  function cardTexture(kind) {
    return canvasTex(512, 320, (g, w, h) => {
      const r = 46;
      g.beginPath(); g.moveTo(r, 0); g.arcTo(w, 0, w, h, r); g.arcTo(w, h, 0, h, r); g.arcTo(0, h, 0, 0, r); g.arcTo(0, 0, w, 0, r); g.closePath(); g.clip();
      const bg = g.createLinearGradient(0, 0, w, h);
      if (kind === 'draw') { bg.addColorStop(0, '#22355F'); bg.addColorStop(1, '#0B1430'); }
      else { bg.addColorStop(0, '#FFB65C'); bg.addColorStop(.55, '#F47216'); bg.addColorStop(1, '#B9481A'); }
      g.fillStyle = bg; g.fillRect(0, 0, w, h);
      g.fillStyle = 'rgba(255,255,255,.12)'; for (let i = 0; i < 9; i++) { g.beginPath(); g.arc(Math.random() * w, Math.random() * h, 30 + Math.random() * 60, 0, 7); g.fill(); }
      g.textAlign = 'center'; g.fillStyle = '#fff';
      if (kind === 'scratch') {
        const f = g.createLinearGradient(60, 150, w - 60, 270); f.addColorStop(0, '#FFE9A8'); f.addColorStop(.5, '#F7CF6B'); f.addColorStop(1, '#D9962C');
        g.font = '800 52px Georgia, serif'; g.fillText('Scratch & Win', w / 2, 95);
        g.fillStyle = f; g.beginPath(); g.roundRect ? g.roundRect(60, 140, w - 120, 130, 26) : g.rect(60, 140, w - 120, 130); g.fill();
        g.fillStyle = 'rgba(120,60,0,.55)'; g.font = '900 30px Arial, sans-serif'; g.fillText('SCRATCH HERE', w / 2, 218);
      } else if (kind === 'won') {
        g.font = '110px serif'; g.fillText('🎁', w / 2, 150);
        g.font = '800 30px Arial, sans-serif'; g.fillStyle = 'rgba(255,255,255,.85)'; g.fillText('YOU WON', w / 2, 212);
        g.fillStyle = '#fff'; g.font = '800 46px Georgia, serif'; g.fillText('Cookie Box', w / 2, 268);
      } else {
        g.fillStyle = '#F7CF6B'; g.font = '800 30px Arial, sans-serif'; g.fillText('LUCKY DRAW', w / 2, 80);
        g.fillStyle = '#fff'; g.font = '800 54px Georgia, serif'; g.fillText('Entry #1042', w / 2, 160);
        g.fillStyle = 'rgba(255,255,255,.7)'; g.font = '600 28px Arial, sans-serif'; g.fillText('Draw on 6 Nov', w / 2, 220);
        g.font = '60px serif'; g.fillText('🛵', w / 2, 292);
      }
    });
  }
  function sparkleTexture() {
    return canvasTex(64, 64, (g, w) => {
      const s = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
      s.addColorStop(0, 'rgba(255,255,255,1)'); s.addColorStop(.25, 'rgba(255,226,150,.9)'); s.addColorStop(1, 'rgba(255,200,90,0)');
      g.fillStyle = s; g.fillRect(0, 0, w, w);
    });
  }

  function makeScene(canvas, { shield = true, coins = 12, cards = 3, sparkles = 420, spread = 1, depth = 0 } = {}) {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: !mobile, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, mobile ? 1.5 : 2));
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    const scene = new THREE.Scene();
    scene.environment = envMap(renderer);
    const camera = new THREE.PerspectiveCamera(38, 1, .1, 100);
    camera.position.set(0, 0, 9);

    scene.add(new THREE.AmbientLight(0x8899ff, .35));
    const key = new THREE.DirectionalLight(0xffe2b0, 2.2); key.position.set(4, 5, 6); scene.add(key);
    const rim = new THREE.PointLight(0x6f8cff, 3, 20); rim.position.set(-5, -2, 2); scene.add(rim);
    const warm = new THREE.PointLight(0xffb84d, 2.4, 14); warm.position.set(2, 1, 4); scene.add(warm);

    const root = new THREE.Group(); scene.add(root);
    const gold = new THREE.MeshPhysicalMaterial({ color: 0xF2BC4E, metalness: 1, roughness: .22, clearcoat: .6, clearcoatRoughness: .2, envMapIntensity: 1.4 });
    const goldBright = new THREE.MeshStandardMaterial({ color: 0xFFE39A, metalness: 1, roughness: .15, emissive: 0x6b4200, emissiveIntensity: .35 });
    // The shield face is painted (not lit) so it always reads as deep navy, like the logo.
    const navyFace = canvasTex(256, 256, (g, w) => {
      const gr = g.createRadialGradient(w * .35, w * .3, 10, w * .5, w * .55, w * .75);
      gr.addColorStop(0, '#2C4A8C'); gr.addColorStop(.55, '#132457'); gr.addColorStop(1, '#070F2B');
      g.fillStyle = gr; g.fillRect(0, 0, w, w);
    });
    const navy = new THREE.MeshBasicMaterial({ map: navyFace, toneMapped: false });

    let shieldGroup = null;
    if (shield) {
      shieldGroup = new THREE.Group();
      const outer = new THREE.ExtrudeGeometry(shieldShape(1), { depth: .34, bevelEnabled: true, bevelThickness: .1, bevelSize: .09, bevelSegments: 8, curveSegments: 48 });
      outer.center();
      shieldGroup.add(new THREE.Mesh(outer, gold));
      const inner = new THREE.ExtrudeGeometry(shieldShape(.8), { depth: .1, bevelEnabled: true, bevelThickness: .04, bevelSize: .03, bevelSegments: 4, curveSegments: 48 });
      inner.center();
      { const p = inner.attributes.position, uv = inner.attributes.uv; for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / 1.7 + .5, p.getY(i) / 2 + .5); uv.needsUpdate = true; }
      const innerMesh = new THREE.Mesh(inner, navy); innerMesh.position.z = .26; innerMesh.position.y = .02; shieldGroup.add(innerMesh);
      const tick = new THREE.CurvePath();
      tick.add(new THREE.LineCurve3(new THREE.Vector3(-.4, .02, 0), new THREE.Vector3(-.1, -.3, 0)));
      tick.add(new THREE.LineCurve3(new THREE.Vector3(-.1, -.3, 0), new THREE.Vector3(.44, .38, 0)));
      const tickMesh = new THREE.Mesh(new THREE.TubeGeometry(tick, 64, .085, 16, false), goldBright);
      tickMesh.position.z = .36; shieldGroup.add(tickMesh);
      for (const end of [new THREE.Vector3(-.4, .02, .36), new THREE.Vector3(.44, .38, .36), new THREE.Vector3(-.1, -.3, .36)]) {
        const cap = new THREE.Mesh(new THREE.SphereGeometry(.085, 20, 20), goldBright); cap.position.copy(end); shieldGroup.add(cap);
      }
      // halo ring behind the shield
      const ring = new THREE.Mesh(new THREE.TorusGeometry(1.75, .018, 12, 160), new THREE.MeshBasicMaterial({ color: 0xF7CF6B, transparent: true, opacity: .45 }));
      ring.position.z = -.4; shieldGroup.add(ring); shieldGroup.userData.ring = ring;
      root.add(shieldGroup);
    }

    // coins orbiting
    const coinGeo = new THREE.CylinderGeometry(.24, .24, .055, 48);
    const coinFace = canvasTex(128, 128, (g, w) => {
      const gr = g.createRadialGradient(w * .4, w * .4, 4, w / 2, w / 2, w / 2); gr.addColorStop(0, '#FFF1C2'); gr.addColorStop(.6, '#F2BC4E'); gr.addColorStop(1, '#B9821F');
      g.fillStyle = gr; g.fillRect(0, 0, w, w);
      g.strokeStyle = 'rgba(120,70,0,.5)'; g.lineWidth = 6; g.beginPath(); g.arc(w / 2, w / 2, w / 2 - 12, 0, 7); g.stroke();
      g.fillStyle = 'rgba(110,60,0,.55)'; g.font = '900 56px Georgia, serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('₹', w / 2, w / 2 + 4);
    });
    const coinFaceMat = new THREE.MeshStandardMaterial({ map: coinFace, metalness: .9, roughness: .3, envMapIntensity: 1.2 });
    const orbiters = [];
    for (let i = 0; i < coins; i++) {
      const coin = new THREE.Mesh(coinGeo, [gold, coinFaceMat, coinFaceMat]);
      const o = { mesh: coin, r: (1.9 + Math.random() * 1.3) * spread, a: (i / coins) * Math.PI * 2, speed: (.12 + Math.random() * .18) * (Math.random() < .5 ? 1 : -1),
        y: (Math.random() - .5) * 2.6 * spread, tilt: Math.random() * Math.PI, spin: .6 + Math.random() * 1.4, bob: Math.random() * 6 };
      root.add(coin); orbiters.push(o);
    }
    const kinds = ['scratch', 'won', 'draw'];
    for (let i = 0; i < cards; i++) {
      const mat = new THREE.MeshBasicMaterial({ map: cardTexture(kinds[i % 3]), transparent: true, side: THREE.DoubleSide, toneMapped: false });
      const card = new THREE.Mesh(new THREE.PlaneGeometry(1.5, .94), mat);
      const o = { mesh: card, card: true, r: (spread > 1 ? 3.4 + i * .4 : 2.25 + i * .2) * spread, a: (i / cards) * Math.PI * 2 + .6, speed: .09 * (i % 2 ? -1 : 1), y: [1.3, -1.25, .2][i % 3] * spread, spin: .25, bob: i * 2 };
      root.add(card); orbiters.push(o);
    }
    // sparkles
    const pos = new Float32Array(sparkles * 3);
    for (let i = 0; i < sparkles; i++) {
      const r = 2 + Math.random() * 6 * spread, t = Math.random() * Math.PI * 2;
      pos[i * 3] = Math.cos(t) * r; pos[i * 3 + 1] = (Math.random() - .5) * 7 * spread; pos[i * 3 + 2] = Math.sin(t) * r - 2;
    }
    const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const points = new THREE.Points(pg, new THREE.PointsMaterial({ size: mobile ? .09 : .07, map: sparkleTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xffe0a0 }));
    scene.add(points);

    const state = { mx: 0, my: 0, tx: 0, ty: 0, scroll: 0, offsetX: 0, offsetY: 0, scale: 1, running: false, raf: 0 };
    function resize() {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h; camera.updateProjectionMatrix();
    }
    const clock = new THREE.Clock();
    function frame() {
      const t = clock.getElapsedTime();
      state.tx += (state.mx - state.tx) * .05; state.ty += (state.my - state.ty) * .05;
      root.position.set(state.offsetX, state.offsetY + state.scroll * 1.6, depth);
      root.scale.setScalar(state.scale * (1 - state.scroll * .25));
      root.rotation.y = state.tx * .35; root.rotation.x = -state.ty * .2;
      if (shieldGroup) {
        shieldGroup.rotation.y = Math.sin(t * .5) * .35 + state.scroll * 2.4;
        shieldGroup.rotation.x = Math.sin(t * .37) * .08;
        shieldGroup.position.y = Math.sin(t * .9) * .12;
        shieldGroup.userData.ring.scale.setScalar(1 + Math.sin(t * 1.6) * .04);
        shieldGroup.userData.ring.material.opacity = .3 + Math.sin(t * 1.6) * .15;
      }
      for (const o of orbiters) {
        const a = o.a + t * o.speed;
        o.mesh.position.set(Math.cos(a) * o.r, o.y + Math.sin(t + o.bob) * .18, Math.sin(a) * o.r * .55 - .4);
        if (o.card) { o.mesh.rotation.y = -a + Math.PI / 2 + Math.sin(t * .6 + o.bob) * .3; o.mesh.rotation.z = Math.sin(t * .5 + o.bob) * .12; o.mesh.lookAt(camera.position.x * .3, o.mesh.position.y, camera.position.z); }
        else { o.mesh.rotation.x = Math.PI / 2 + Math.sin(t * o.spin) * .6; o.mesh.rotation.z = t * o.spin + o.tilt; }
      }
      points.rotation.y = t * .03; points.position.y = Math.sin(t * .3) * .1;
      renderer.render(scene, camera);
    }
    function loop() { if (!state.running) return; frame(); state.raf = requestAnimationFrame(loop); }
    const api = {
      state, resize,
      start() { if (state.running || reduce) return; state.running = true; clock.start(); loop(); },
      stop() { state.running = false; cancelAnimationFrame(state.raf); },
      once() { resize(); frame(); },
    };
    resize();
    addEventListener('resize', resize);
    // Only render while on screen.
    new IntersectionObserver(([e]) => { e.isIntersecting ? api.start() : api.stop(); }, { threshold: 0 }).observe(canvas);
    if (reduce) api.once();
    return api;
  }

  let hero = null;
  if (window.THREE && webglOk()) {
    try {
      hero = makeScene($('#hero3d'), { coins: mobile ? 8 : 12, cards: mobile ? 2 : 3, sparkles: mobile ? 220 : 420 });
      const place = () => {
        const wide = innerWidth > 860;
        hero.state.offsetX = wide ? Math.min(3, innerWidth / 470) : 0;
        hero.state.offsetY = wide ? 0 : 1.95;
        hero.state.scale = wide ? 1 : .5;
        hero.resize();
      };
      place(); addEventListener('resize', place);
      addEventListener('pointermove', e => {
        hero.state.mx = (e.clientX / innerWidth) * 2 - 1;
        hero.state.my = (e.clientY / innerHeight) * 2 - 1;
      }, { passive: true });
      if (hasGsap) ScrollTrigger.create({ trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true, onUpdate: s => { hero.state.scroll = s.progress; } });
      makeScene($('#final3d'), { shield: false, coins: mobile ? 10 : 18, cards: 3, sparkles: mobile ? 200 : 380, spread: 1.7, depth: -3 });
    } catch (e) { console.warn('3D disabled:', e); document.body.classList.add('no3d'); }
  } else document.body.classList.add('no3d');

  // ---------------------------------------------------------------- GSAP reveals
  if (hasGsap && !reduce) {
    gsap.registerPlugin(ScrollTrigger);
    gsap.to('.hero .reveal', { opacity: 1, y: 0, duration: 1.1, ease: 'power3.out', stagger: .12, delay: .15 });
    const groups = ['.trust-item', '.modes h2, .modes .eyebrow', '.mode', '.genuine h2, .genuine .sub, .genuine .eyebrow', '.g-card',
      '.demo-grid > *', '.biz .devices', '.biz h2, .biz .eyebrow', '.feat li', '.who-copy > *', '.contact-card',
      '.faq h2, .faq .eyebrow', 'details', '.final-copy > *', '.how-text h2, .how-text .eyebrow'];
    for (const sel of groups) {
      gsap.set(sel, { opacity: 0, y: 40 });
      ScrollTrigger.batch(sel, { start: 'top 88%', once: true, onEnter: els => gsap.to(els, { opacity: 1, y: 0, duration: .9, ease: 'power3.out', stagger: .08 }) });
    }
    // counters
    $$('[data-count]').forEach(el => {
      const end = +el.dataset.count, suf = el.dataset.suffix || '';
      const obj = { v: 0 };
      ScrollTrigger.create({ trigger: el, start: 'top 90%', once: true,
        onEnter: () => gsap.to(obj, { v: end, duration: 1.6, ease: 'power2.out', onUpdate: () => { el.textContent = Math.round(obj.v) + suf; } }) });
      el.textContent = (end === 0 ? 0 : 0) + suf;
    });
    // tamper-proof chain links up
    const chainTl = gsap.timeline({ scrollTrigger: { trigger: '#chain', start: 'top 80%', once: true } });
    $$('#chain > *').forEach(el => {
      if (el.classList.contains('link')) chainTl.from(el, mobile ? { scaleY: 0, transformOrigin: 'top', duration: .3 } : { scaleX: 0, duration: .35, ease: 'power2.out' });
      else chainTl.from(el, { opacity: 0, y: 20, scale: .9, duration: .45, ease: 'back.out(1.6)' });
    });
    chainTl.to('#chain .seal', { boxShadow: '0 0 40px rgba(34,208,122,.45)', repeat: 1, yoyo: true, duration: .5 });
    // the receipt prints line by line, then the coupon tears off a little
    const rc = gsap.timeline({ scrollTrigger: { trigger: '#receipt', start: 'top 80%', once: true } });
    rc.from('#receipt', { clipPath: 'inset(0 0 100% 0)', duration: 1.6, ease: 'steps(24)' })
      .from('#receipt .r-line', { opacity: 0, x: -8, duration: .25, stagger: .08 }, '-=1.2')
      .to('#receipt .r-coupon', { rotate: 3.5, y: 10, duration: .7, ease: 'back.out(2)' }, '+=.1');
    // dashboard bars grow
    gsap.from('.lp-bars i', { scaleY: 0, duration: 1, ease: 'power3.out', stagger: .06, scrollTrigger: { trigger: '.devices', start: 'top 80%', once: true } });
    // final CTA zoom
    gsap.from('.final-copy', { scale: .92, duration: 1.2, ease: 'power3.out', scrollTrigger: { trigger: '.final', start: 'top 75%', once: true } });
  } else {
    $$('[data-count]').forEach(el => { el.textContent = el.dataset.count + (el.dataset.suffix || ''); });
  }

  // ---------------------------------------------------------------- how it works story
  const steps = $$('#steps li'), scenes = $$('.how-stage .scene');
  let cur = -1;
  function setStep(i) {
    if (i === cur) return; cur = i;
    steps.forEach((s, k) => s.classList.toggle('on', k === i));
    scenes.forEach((s, k) => s.classList.toggle('on', k === i));
    $$('.how-dots i').forEach((d, k) => d.classList.toggle('on', k === i));
  }
  setStep(0);
  // Desktop and phone both pin the section and step through it as you scroll; the phone layout shows one step at a time.
  if (hasGsap && !reduce) {
    ScrollTrigger.config({ ignoreMobileResize: true });
    const how = $('.how');
    gsap.matchMedia().add({ wide: '(min-width: 861px)', narrow: '(max-width: 860px)' }, ctx => {
      const { wide } = ctx.conditions;
      how.classList.add('pinned');
      const st = ScrollTrigger.create({ trigger: '.how-pin', start: 'top top', end: wide ? '+=240%' : '+=200%', pin: true, scrub: true, anticipatePin: 1,
        onUpdate: s => setStep(Math.min(3, Math.floor(s.progress * 4))), onToggle: s => document.body.classList.toggle('story', s.isActive && !wide) });
      const go = i => {
        const y = st.start + (st.end - st.start) * ((i + .5) / 4);
        lenis ? lenis.scrollTo(y, { duration: 1 }) : scrollTo({ top: y, behavior: 'smooth' });
      };
      const handlers = [...steps, ...$$('.how-dots i')].map(el => {
        const i = el.dataset.i != null ? +el.dataset.i : steps.indexOf(el);
        const h = () => go(i); el.addEventListener('click', h); return () => el.removeEventListener('click', h);
      });
      if (wide) gsap.to('.phone', { rotate: 3, ease: 'none', scrollTrigger: { trigger: '.how-pin', start: 'top top', end: '+=240%', scrub: true } });
      return () => { how.classList.remove('pinned'); handlers.forEach(off => off()); };
    });
  } else {
    let timer = null;
    const cycle = () => { clearInterval(timer); if (!reduce) timer = setInterval(() => setStep((cur + 1) % 4), 2800); };
    steps.forEach((s, i) => s.addEventListener('click', () => { setStep(i); cycle(); }));
    new IntersectionObserver(([en]) => { en.isIntersecting ? cycle() : clearInterval(timer); }, { threshold: .3 }).observe($('.how'));
  }

  // ---------------------------------------------------------------- mode cards: tilt on desktop, auto-play on touch
  $$('.tilt').forEach(card => {
    if (mobile) {
      new IntersectionObserver(([e]) => card.classList.toggle('play', e.isIntersecting), { threshold: .6 }).observe(card);
      return;
    }
    card.addEventListener('pointermove', e => {
      const r = card.getBoundingClientRect(), x = (e.clientX - r.left) / r.width - .5, y = (e.clientY - r.top) / r.height - .5;
      card.style.transform = `rotateY(${x * 10}deg) rotateX(${-y * 10}deg) translateY(-4px)`;
    });
    card.addEventListener('pointerleave', () => { card.style.transform = ''; });
  });

  // ---------------------------------------------------------------- live scratch demo
  const PRIZES = [['🎂', 'Celebration Cake'], ['🍪', 'Cookie Box'], ['☕', 'Free Coffee'], ['🧁', 'Cupcake Treat'], ['🛍️', '10% Off Next Bill']];
  const foil = $('#demoFoil'), card = $('#demoCard');
  let ctx, done = false;
  function drawFoil() {
    const r = card.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
    foil.width = r.width * dpr; foil.height = r.height * dpr;
    ctx = foil.getContext('2d', { willReadFrequently: true });
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = r.width, H = r.height;
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#FFD98A'); g.addColorStop(.4, '#F7B23C'); g.addColorStop(.7, '#E8851F'); g.addColorStop(1, '#C9661A');
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    const sh = ctx.createLinearGradient(0, H, W, 0);
    sh.addColorStop(.3, 'rgba(255,255,255,0)'); sh.addColorStop(.5, 'rgba(255,255,255,.35)'); sh.addColorStop(.7, 'rgba(255,255,255,0)');
    ctx.fillStyle = sh; ctx.fillRect(0, 0, W, H);
    ctx.save(); ctx.translate(W / 2, H / 2); ctx.rotate(-Math.PI / 7);
    ctx.font = '800 14px "Albert Sans", sans-serif'; ctx.fillStyle = 'rgba(255,255,255,.17)'; ctx.textAlign = 'center';
    for (let y = -H; y < H; y += 28) for (let x = -W; x < W; x += 120) ctx.fillText('GENUINE DRAW', x + (y / 28 % 2 ? 60 : 0), y);
    ctx.restore();
    ctx.fillStyle = 'rgba(255,255,255,.8)';
    for (let i = 0; i < 30; i++) { ctx.beginPath(); ctx.arc(Math.random() * W, Math.random() * H, Math.random() * 1.8 + .4, 0, 7); ctx.fill(); }
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff';
    ctx.font = '44px serif'; ctx.fillText('🎁', W / 2, H / 2 - 22);
    ctx.font = '900 22px "Albert Sans", sans-serif'; ctx.shadowColor = 'rgba(120,40,0,.45)'; ctx.shadowBlur = 6;
    ctx.fillText('SCRATCH HERE', W / 2, H / 2 + 34); ctx.shadowBlur = 0;
    ctx.globalCompositeOperation = 'destination-out';
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(34, W * .13);
  }
  function newPrize() {
    const [e, n] = PRIZES[Math.floor(Math.random() * PRIZES.length)];
    $('#demoEmoji').textContent = e; $('#demoName').textContent = n;
    $('#demoPrize').style.transform = '';
  }
  function resetDemo() { done = false; foil.classList.remove('gone'); $('#demoHint').textContent = '👆 Scratch here'; newPrize(); drawFoil(); }
  let drawing = false, last = null, strokes = 0;
  const pos = e => { const r = foil.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  foil.addEventListener('pointerdown', e => { if (done) return; drawing = true; last = pos(e); try { foil.setPointerCapture(e.pointerId); } catch {} scratch(e); });
  foil.addEventListener('pointermove', scratch);
  foil.addEventListener('pointerup', () => { drawing = false; check(); });
  foil.addEventListener('pointercancel', () => { drawing = false; });
  function scratch(e) {
    if (!drawing || done) return;
    const p = pos(e);
    ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x + .1, p.y + .1); ctx.stroke();
    last = p; if (++strokes % 6 === 0) check();
  }
  function check() {
    if (done) return;
    const d = ctx.getImageData(0, 0, foil.width, foil.height).data;
    let clear = 0, total = 0;
    for (let i = 3; i < d.length; i += 4 * 32) { total++; if (d[i] < 40) clear++; }
    if (clear / total > .45) {
      done = true; foil.classList.add('gone');
      $('#demoHint').textContent = '🎉 That\'s how it feels!';
      if (hasGsap && !reduce) gsap.fromTo('#demoPrize', { scale: .7 }, { scale: 1, duration: .8, ease: 'elastic.out(1, .5)' });
      if (navigator.vibrate) navigator.vibrate([40, 30, 80]);
    }
  }
  $('#demoReset').addEventListener('click', resetDemo);
  let lastW = 0;
  addEventListener('resize', () => { const w = card.clientWidth; if (Math.abs(w - lastW) > 4 && !done) { lastW = w; drawFoil(); } });
  document.fonts && document.fonts.ready.then(() => { lastW = card.clientWidth; resetDemo(); });
  lastW = card.clientWidth; resetDemo();

  if (hasGsap) addEventListener('load', () => ScrollTrigger.refresh());
})();
