// Voxel shader: baked AO + sky light scaled by time of day + coloured block light.
import * as THREE from '../../vendor/three/three.module.js';

const vertex = /* glsl */ `
  attribute vec4 aLight;
  varying vec2 vUv;
  varying vec4 vLight;
  varying vec3 vWorld;
  varying float vDist;
  void main() {
    vUv = uv;
    vLight = aLight;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vec4 mv = viewMatrix * world;
    vDist = length(mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const fragment = /* glsl */ `
  uniform sampler2D uAtlas;
  uniform float uDaylight;
  uniform vec3 uSkyLight;
  uniform vec3 uBlockLight;
  uniform vec3 uFogColor;
  uniform float uFogNear;
  uniform float uFogFar;
  uniform float uTime;
  uniform float uOpacity;
  varying vec2 vUv;
  varying vec4 vLight;
  varying vec3 vWorld;
  varying float vDist;
  void main() {
    vec4 tex = texture2D(uAtlas, vUv);
    if (tex.a < 0.05) discard;
    float shade = vLight.x;
    float sky = pow(vLight.y, 1.6);
    float blk = vLight.z * vLight.z;
    vec3 light = vec3(0.1, 0.11, 0.16) + uSkyLight * sky * uDaylight + uBlockLight * blk;
    vec3 col = tex.rgb * shade * light;
    if (vLight.w > 0.5) {
      float pulse = 0.92 + 0.08 * sin(uTime * 2.0 + vWorld.x * 0.3 + vWorld.z * 0.3);
      col = tex.rgb * 1.15 * pulse;
    }
    float a = tex.a * uOpacity;
    #ifdef TRANSLUCENT
      a = max(a, 0.35);
      col += vec3(0.0, 0.08, 0.12) * (0.5 + 0.5 * sin(uTime * 3.0 + vWorld.x * 0.8 + vWorld.z * 0.6));
    #endif
    float fog = smoothstep(uFogNear, uFogFar, vDist);
    gl_FragColor = vec4(mix(col, uFogColor, fog), a);
  }
`;

export function createVoxelMaterials(atlasTexture) {
  const uniforms = {
    uAtlas: { value: atlasTexture },
    uDaylight: { value: 1 },
    uSkyLight: { value: new THREE.Color(1, 1, 1) },
    uBlockLight: { value: new THREE.Color(0.75, 0.95, 1.1) },
    uFogColor: { value: new THREE.Color(0.1, 0.2, 0.3) },
    uFogNear: { value: 60 },
    uFogFar: { value: 120 },
    uTime: { value: 0 },
    uOpacity: { value: 1 },
  };
  const opaque = new THREE.ShaderMaterial({ uniforms, vertexShader: vertex, fragmentShader: fragment });
  const translucentUniforms = { ...uniforms, uOpacity: { value: 0.72 } };
  const translucent = new THREE.ShaderMaterial({
    uniforms: translucentUniforms,
    vertexShader: vertex,
    fragmentShader: fragment,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    defines: { TRANSLUCENT: 1 },
  });
  return { opaque, translucent, uniforms };
}
