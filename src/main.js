import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'

const loaderEl = document.getElementById('loader')
const playBtn = document.getElementById('play-btn')
const hudEl = document.getElementById('hud')
const levelsEl = document.getElementById('levels')
const timeEl = document.getElementById('time')
const debugEl = document.getElementById('debug')

// Build simple level bars for visual feedback
for (let i = 0; i < 48; i++) {
	const b = document.createElement('div')
	b.className = 'bar'
	b.style.height = '2px'
	levelsEl.appendChild(b)
}

let audioCtx
let audio
let analyser
let dataArray

let renderer, scene, camera
let controls
let water
let dolphin
const keysDown = {}
let lastFrameTime = performance.now()

function createRenderer() {
	renderer = new THREE.WebGLRenderer({ antialias: true })
	renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
	renderer.setSize(window.innerWidth, window.innerHeight)
	renderer.outputColorSpace = THREE.SRGBColorSpace
	renderer.setClearColor(0x00334a, 1)
	document.body.appendChild(renderer.domElement)
}

function createScene() {
	scene = new THREE.Scene()
	scene.fog = new THREE.FogExp2(0x063b52, 0.02)
	scene.background = new THREE.Color(0x00334a)

	camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 2000)
	camera.position.set(0, 1.6, 4)

	const hemi = new THREE.HemisphereLight(0xaee6ff, 0x082033, 1.0)
	scene.add(hemi)
	const dir = new THREE.DirectionalLight(0xffffff, 1.0)
	dir.position.set(5, 10, 2)
	scene.add(dir)
	const amb = new THREE.AmbientLight(0x5fa8d3, 0.3)
	scene.add(amb)

	// Skydome gradient for underwater feel
	const skyGeo = new THREE.SphereGeometry(800, 32, 32)
	const skyMat = new THREE.ShaderMaterial({
		uniforms: {
			top: { value: new THREE.Color(0x0a789c) },
			bottom: { value: new THREE.Color(0x00212e) }
		},
		vertexShader: 'varying vec3 vPos; void main(){ vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
		fragmentShader: 'varying vec3 vPos; uniform vec3 top; uniform vec3 bottom; void main(){ float h = clamp((vPos.y/800.0)*0.5+0.5, 0.0,1.0); gl_FragColor = vec4(mix(bottom, top, h), 1.0); }',
		side: THREE.BackSide,
		depthWrite: false
	})
	const sky = new THREE.Mesh(skyGeo, skyMat)
	scene.add(sky)

	// Bright debug cube and torus at origin to guarantee visibility
	const marker = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffff00 }))
	marker.position.set(0, 1, 0)
	scene.add(marker)
	const torus = new THREE.Mesh(new THREE.TorusKnotGeometry(0.6, 0.2, 128, 16), new THREE.MeshBasicMaterial({ color: 0xff00ff, wireframe: true }))
	torus.position.set(0, 1, -2)
	scene.add(torus)
}

function createWater() {
	const geometry = new THREE.PlaneGeometry(1000, 1000, 256, 256)
	geometry.rotateX(-Math.PI / 2)

	const uniforms = {
		uTime: { value: 0 },
		uColorDeep: { value: new THREE.Color(0x00bfff) },
		uColorShallow: { value: new THREE.Color(0x84ffff) },
		uWaveA: { value: new THREE.Vector3(0.28, 0.32, 0.7) }, // ampX, ampZ, speed
		uWaveB: { value: new THREE.Vector3(0.10, 0.12, 1.2) },
	}

	const material = new THREE.ShaderMaterial({
		uniforms,
		vertexShader: `
 varying vec3 vWorldPos;
 uniform float uTime;
 uniform vec3 uWaveA; // x: ampX, y: ampZ, z: speed
 uniform vec3 uWaveB;
 void main() {
   vec3 p = position;
   float t = uTime * 0.5;
   p.y += sin(p.x * 0.12 + t * uWaveA.z) * uWaveA.x;
   p.y += cos(p.z * 0.10 + t * uWaveB.z) * uWaveB.y;
   vec4 world = modelMatrix * vec4(p, 1.0);
   vWorldPos = world.xyz;
   gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
 }
 		`,
		fragmentShader: `
 varying vec3 vWorldPos;
 uniform vec3 uColorDeep;
 uniform vec3 uColorShallow;
 void main(){
   float h = clamp((vWorldPos.y + 1.0) * 0.5, 0.0, 1.0);
   vec3 col = mix(uColorDeep, uColorShallow, h);
   gl_FragColor = vec4(col, 1.0);
 }
 		`,
		wireframe: false,
		transparent: false,
		side: THREE.DoubleSide
	})

	water = new THREE.Mesh(geometry, material)
	water.position.y = 0.2
	scene.add(water)

	// Seabed
	const seabed = new THREE.Mesh(
		new THREE.PlaneGeometry(2000, 2000),
		new THREE.MeshStandardMaterial({ color: 0x0b2d2d, roughness: 1, metalness: 0 })
	)
	seabed.rotation.x = -Math.PI / 2
	seabed.position.y = -5
	scene.add(seabed)
}

function createDolphinPlaceholder() {
	const body = new THREE.CapsuleGeometry(0.25, 1.1, 8, 16)
	const mat = new THREE.MeshStandardMaterial({ color: 0x7fbcd4, metalness: 0.1, roughness: 0.6 })
	dolphin = new THREE.Mesh(body, mat)
	dolphin.rotation.x = Math.PI * 0.02
	dolphin.position.set(0, 1.2, 0)
	scene.add(dolphin)
}

async function tryLoadDolphinOBJ() {
	const exists = await fileExists('/dolphin_color.obj')
	if (!exists) {
		createDolphinPlaceholder()
		return
	}
	try {
		const loader = new OBJLoader()
		const obj = await loader.loadAsync('/dolphin_color.obj')
		obj.traverse((c) => {
			if (c.isMesh) {
				c.material = new THREE.MeshStandardMaterial({ color: 0x88c5d8, metalness: 0.1, roughness: 0.6 })
			}
		})
		dolphin = obj
		dolphin.scale.setScalar(0.8)
		dolphin.position.set(0, 1.2, -1)
		scene.add(dolphin)
	} catch {
		createDolphinPlaceholder()
	}
}

async function fileExists(path) {
	try {
		const res = await fetch(path, { method: 'GET' })
		if (!res.ok) return false
		const contentType = (res.headers.get('content-type') || '').toLowerCase()
		if (contentType.includes('text/html')) return false
		const text = await res.text()
		if (text.trim().toLowerCase().startsWith('<!doctype html')) return false
		return text.trim().length > 0
	} catch {
		return false
	}
}

function attachCameraToDolphin() {
	if (!dolphin) return
	// third-person starting position; camera follows in animate()
	camera.position.set(0, 1.6, 4)
	camera.lookAt(dolphin.position)
	controls = new OrbitControls(camera, renderer.domElement)
	controls.enableDamping = true
	controls.target.copy(new THREE.Vector3(0, 1.0, 0))
	controls.maxPolarAngle = Math.PI * 0.95
	controls.minDistance = 0.5
	controls.maxDistance = 8
	controls.enablePan = false
}

function setupAudio() {
	audioCtx = new (window.AudioContext || window.webkitAudioContext)()
	audio = new Audio('/n2d33p.mp3')
	audio.crossOrigin = 'anonymous'
	audio.loop = true
	const src = audioCtx.createMediaElementSource(audio)
	analyser = audioCtx.createAnalyser()
	analyser.fftSize = 1024
	dataArray = new Uint8Array(analyser.frequencyBinCount)
	src.connect(analyser)
	analyser.connect(audioCtx.destination)
}

function updateLevelBars() {
	if (!analyser) return
	analyser.getByteFrequencyData(dataArray)
	const bars = levelsEl.children
	const step = Math.floor(dataArray.length / bars.length)
	for (let i = 0; i < bars.length; i++) {
		const v = dataArray[i * step] / 255
		bars[i].style.height = `${Math.max(2, v * 12)}px`
		bars[i].style.opacity = String(0.6 + v * 0.4)
	}
}

function updateTimeUI() {
	if (!audio) return
	const mm = Math.floor(audio.currentTime / 60).toString().padStart(2, '0')
	const ss = Math.floor(audio.currentTime % 60).toString().padStart(2, '0')
	timeEl.textContent = `${mm}:${ss}`
}

function animate() {
	requestAnimationFrame(animate)
	const now = performance.now()
	const t = now * 0.001
	const dt = Math.min(0.05, (now - lastFrameTime) / 1000)
	lastFrameTime = now
	if (water) {
		water.material.uniforms.uTime.value = t
		water.position.y = 0.2
	}
	if (dolphin) {
		const bob = Math.sin(t * 2.0) * 0.03
		dolphin.position.y = 1.2 + bob

		let speed = 1.6
		let rotSpeed = 1.9
		let upDown = 0
		if (analyser && dataArray) {
			let sum = 0
			for (let i = 0; i < 16; i++) sum += dataArray[i]
			const bass = sum / (16 * 255)
			speed += bass * 2.0
		}
		if (keysDown['KeyA']) dolphin.rotation.y += rotSpeed * dt
		if (keysDown['KeyD']) dolphin.rotation.y -= rotSpeed * dt
		const forward = new THREE.Vector3(0, 0, 1).applyEuler(dolphin.rotation)
		const right = new THREE.Vector3(1, 0, 0).applyEuler(dolphin.rotation)
		if (keysDown['KeyW']) dolphin.position.addScaledVector(forward, speed * dt)
		if (keysDown['KeyS']) dolphin.position.addScaledVector(forward, -speed * dt)
		if (keysDown['KeyQ']) dolphin.position.addScaledVector(right, -speed * 0.7 * dt)
		if (keysDown['KeyE']) dolphin.position.addScaledVector(right, speed * 0.7 * dt)
		if (keysDown['Space']) upDown += 1
		if (keysDown['ShiftLeft'] || keysDown['ShiftRight']) upDown -= 1
		dolphin.position.y += upDown * speed * 0.6 * dt
		if (dolphin.position.y < 0.6) dolphin.position.y = 0.6
	}
	if (controls) controls.update()
	updateLevelBars()
	updateTimeUI()
	if (debugEl) debugEl.textContent = `cam:${camera.position.x.toFixed(1)},${camera.position.y.toFixed(1)},${camera.position.z.toFixed(1)} | dol:${dolphin ? `${dolphin.position.x.toFixed(1)},${dolphin.position.y.toFixed(1)},${dolphin.position.z.toFixed(1)}` : 'none'} | waterY:${water ? water.position.y.toFixed(1) : 'n/a'}`
	renderer.render(scene, camera)
}

function onResize() {
	camera.aspect = window.innerWidth / window.innerHeight
	camera.updateProjectionMatrix()
	renderer.setSize(window.innerWidth, window.innerHeight)
}

async function start() {
	loaderEl.style.display = 'none'
	hudEl.style.display = 'grid'
	if (debugEl) debugEl.style.display = 'block'

	createRenderer()
	createScene()
	createWater()
	await tryLoadDolphinOBJ()
	attachCameraToDolphin()
	// place dolphin above water so we can see it immediately
	if (dolphin) dolphin.position.set(0, 1.2, 0)
	setupAudio()
	audio.play()
	window.addEventListener('resize', onResize)
	window.addEventListener('keydown', (e) => { keysDown[e.code] = true })
	window.addEventListener('keyup', (e) => { keysDown[e.code] = false })
	animate()
}

playBtn.addEventListener('click', async () => {
	try {
		await start()
	} catch (err) {
		console.error(err)
		alert('Failed to start experience. See console for details.')
	}
})


