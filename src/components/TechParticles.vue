<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

const canvas = ref<HTMLCanvasElement | null>(null)
let frame = 0
let observer: ResizeObserver | null = null
let particles: Array<{ x: number; y: number; vx: number; vy: number; radius: number }> = []

function start(): void {
  const el = canvas.value
  const host = el?.parentElement
  const context = el?.getContext('2d')
  if (!el || !host || !context) return

  let width = 0
  let height = 0
  let ratio = 1
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  const seed = () => {
    const count = Math.max(20, Math.min(38, Math.round(width / 11)))
    particles = Array.from({ length: count }, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      vx: reduceMotion ? 0 : (Math.random() - 0.5) * 0.16,
      vy: reduceMotion ? 0 : (Math.random() - 0.5) * 0.16,
      radius: 0.5 + Math.random() * 1.1
    }))
  }

  const resize = () => {
    const rect = host.getBoundingClientRect()
    width = rect.width
    height = rect.height
    ratio = Math.min(window.devicePixelRatio || 1, 2)
    el.width = Math.round(width * ratio)
    el.height = Math.round(height * ratio)
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    seed()
  }

  const draw = () => {
    context.clearRect(0, 0, width, height)
    const light = document.documentElement.dataset.theme === 'light'
    for (let index = 0; index < particles.length; index += 1) {
      const point = particles[index]
      point.x += point.vx
      point.y += point.vy
      if (point.x < 0 || point.x > width) point.vx *= -1
      if (point.y < 0 || point.y > height) point.vy *= -1

      context.beginPath()
      context.arc(point.x, point.y, point.radius, 0, Math.PI * 2)
      context.fillStyle = light ? 'rgba(63,95,224,.38)' : 'rgba(91,196,255,.58)'
      context.shadowBlur = 8
      context.shadowColor = light ? '#6d8bff' : '#35c6ff'
      context.fill()
      context.shadowBlur = 0

      for (let peerIndex = index + 1; peerIndex < particles.length; peerIndex += 1) {
        const peer = particles[peerIndex]
        const dx = point.x - peer.x
        const dy = point.y - peer.y
        const distance = Math.sqrt(dx * dx + dy * dy)
        if (distance > 78) continue
        context.beginPath()
        context.moveTo(point.x, point.y)
        context.lineTo(peer.x, peer.y)
        context.strokeStyle = light
          ? `rgba(63,95,224,${(1 - distance / 78) * 0.11})`
          : `rgba(109,139,255,${(1 - distance / 78) * 0.16})`
        context.lineWidth = 0.65
        context.stroke()
      }
    }
    if (!reduceMotion) frame = window.requestAnimationFrame(draw)
  }

  observer = new ResizeObserver(() => {
    resize()
    if (reduceMotion) draw()
  })
  observer.observe(host)
  resize()
  draw()
}

onMounted(start)
onBeforeUnmount(() => {
  window.cancelAnimationFrame(frame)
  observer?.disconnect()
})
</script>

<template>
  <canvas ref="canvas" class="tech-particles" aria-hidden="true" />
</template>

<style scoped>
.tech-particles {
  position: absolute;
  inset: 0;
  z-index: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  opacity: 0.62;
}
</style>
