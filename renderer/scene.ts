import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export async function render(base64: string, extension: string): Promise<string> {
  const data = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
  const manager = new THREE.LoadingManager();
  manager.setURLModifier(value => {
    if (!value.startsWith('data:') && !value.startsWith('blob:')) throw new Error('External model resources are forbidden');
    return value;
  });
  let loading = false;
  let finishLoading!: () => void;
  let failLoading!: (error: Error) => void;
  const resources = new Promise<void>((resolve, reject) => { finishLoading = resolve; failLoading = reject; });
  // Attach a handler even when parsing itself fails before the await below.
  void resources.catch(() => {});
  manager.onStart = () => { loading = true; };
  manager.onLoad = () => finishLoading();
  manager.onError = () => failLoading(new Error('Embedded model resource failed'));
  let object: THREE.Object3D;
  if (extension === 'obj') object = new OBJLoader(manager).parse(new TextDecoder().decode(data));
  else if (extension === 'stl') object = new THREE.Mesh(new STLLoader(manager).parse(data.buffer), new THREE.MeshStandardMaterial({ color: 0x7b9cc4 }));
  else if (extension === 'fbx') object = new FBXLoader(manager).parse(data.buffer, '');
  else object = (await new Promise<import('three/examples/jsm/loaders/GLTFLoader.js').GLTF>((resolve, reject) => new GLTFLoader(manager).parse(data.buffer, '', resolve, reject))).scene;
  if (loading) await resources;
  const bounds = new THREE.Box3().setFromObject(object);
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const extent = Math.max(size.x, size.y, size.z);
  if (!Number.isFinite(extent) || extent <= 0) throw new Error('Model has no finite geometry');
  object.position.sub(center); object.scale.setScalar(2 / extent);
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x202733); scene.add(object);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x405070, 2));
  const light = new THREE.DirectionalLight(0xffffff, 3); light.position.set(3, 4, 5); scene.add(light);
  const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100); camera.position.set(3.3, 2.4, 3.3); camera.lookAt(0, 0, 0);
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(320, 320); renderer.render(scene, camera);
  const png = renderer.domElement.toDataURL('image/png'); renderer.dispose();
  return png.slice(png.indexOf(',') + 1);
}
