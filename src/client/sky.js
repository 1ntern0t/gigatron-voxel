// Aurora data-sky: gradient dome, sun/moon, stars and animated aurora ribbons.
import * as THREE from '../../vendor/three/three.module.js';

const vertex = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww;
  }
`;

const fragment = /* glsl */ `
  uniform float uTime;
  uniform float uDay;
  uniform vec3 uSunDir;
  varying vec3 vDir;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
  void main() {
    vec3 d = normalize(vDir);
    float h = clamp(d.y, -1.0, 1.0);
    vec3 dayTop = vec3(0.07, 0.35, 0.62);
    vec3 dayHor = vec3(0.55, 0.85, 0.95);
    vec3 nightTop = vec3(0.01, 0.01, 0.05);
    vec3 nightHor = vec3(0.05, 0.03, 0.14);
    vec3 top = mix(nightTop, dayTop, uDay);
    vec3 hor = mix(nightHor, dayHor, uDay);
    vec3 col = mix(hor, top, pow(max(h, 0.0), 0.5));
    if (h < 0.0) col = mix(hor, vec3(0.02, 0.02, 0.05), min(1.0, -h * 3.0));
    // Horizon data-grid glow.
    col += vec3(0.0, 0.6, 0.8) * exp(-abs(h) * 40.0) * (0.25 + 0.35 * (1.0 - uDay));
    // Sun and moon.
    float sd = dot(d, uSunDir);
    col += vec3(1.0, 0.85, 0.6) * smoothstep(0.9985, 0.9995, sd) * 2.0 + vec3(1.0, 0.7, 0.4) * pow(max(sd, 0.0), 64.0) * 0.4 * uDay;
    float md = dot(d, -uSunDir);
    col += vec3(0.7, 0.85, 1.0) * smoothstep(0.9990, 0.9996, md) * (1.0 - uDay);
    float night = 1.0 - uDay;
    if (h > 0.0 && night > 0.01) {
      // Stars.
      vec2 sp = d.xz / (d.y + 0.2) * 120.0;
      float s = step(0.997, hash(floor(sp)));
      col += vec3(0.8, 0.9, 1.0) * s * night * (0.6 + 0.4 * sin(uTime * 3.0 + hash(floor(sp)) * 50.0));
      // Aurora ribbons.
      vec2 ap = d.xz / (d.y + 0.15);
      float a = 0.0;
      for (int i = 0; i < 3; i++) {
        float fi = float(i);
        float wave = sin(ap.x * (1.2 + fi * 0.4) + uTime * 0.15 * (fi + 1.0) + noise(ap * 1.5 + fi) * 3.0);
        float band = exp(-pow((ap.y + wave * 0.6 - 1.0 + fi * 0.8), 2.0) * 3.0);
        a += band * (0.5 + 0.5 * noise(vec2(ap.x * 3.0 + uTime * 0.3, fi)));
      }
      a *= smoothstep(0.05, 0.35, h) * night;
      vec3 auroraCol = mix(vec3(0.0, 1.0, 0.75), vec3(0.6, 0.2, 1.0), 0.5 + 0.5 * sin(ap.x * 0.7 + uTime * 0.2));
      col += auroraCol * a * 0.55;
      // Falling data glyph streaks.
      float colId = floor(ap.x * 14.0);
      float streak = fract(ap.y * 0.6 + uTime * (0.1 + hash(vec2(colId, 3.0)) * 0.2));
      col += vec3(0.0, 0.8, 1.0) * step(0.985, hash(vec2(colId, 1.0))) * smoothstep(0.9, 1.0, streak) * night * 0.6;
    }
    gl_FragColor = vec4(col, 1.0);
  }
`;

export function createSky() {
  const uniforms = { uTime: { value: 0 }, uDay: { value: 1 }, uSunDir: { value: new THREE.Vector3(0, 1, 0) } };
  const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: vertex, fragmentShader: fragment, side: THREE.BackSide, depthWrite: false, depthTest: false });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(500, 32, 16), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  return { mesh, uniforms };
}

// Day cycle: returns daylight factor, sun direction and fog colour for a time in seconds.
export const DAY_LENGTH = 600;

export function dayState(time) {
  const phase = ((time % DAY_LENGTH) + DAY_LENGTH) % DAY_LENGTH / DAY_LENGTH; // 0 = sunrise
  const angle = phase * Math.PI * 2;
  const sun = new THREE.Vector3(Math.cos(angle), Math.sin(angle), 0.25).normalize();
  const day = THREE.MathUtils.smoothstep(sun.y, -0.15, 0.25);
  const fog = new THREE.Color().lerpColors(new THREE.Color(0.04, 0.03, 0.12), new THREE.Color(0.5, 0.78, 0.9), day);
  const hours = (phase * 24 + 6) % 24;
  return { day, sun, fog, hours };
}
