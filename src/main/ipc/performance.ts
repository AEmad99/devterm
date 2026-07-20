import { app, ipcMain } from 'electron'
import { IPC, type PerformanceSnapshot } from '@shared/types'

const mb = (bytes: number): number => Math.round((bytes / 1024 / 1024) * 10) / 10
const kibToMb = (kib: number): number => Math.round((kib / 1024) * 10) / 10

/**
 * Local, on-demand process telemetry for the Settings performance panel.
 * Nothing is sampled in the background and no value leaves the machine.
 */
export function registerPerformanceIpc(): void {
  ipcMain.handle(IPC.performanceSnapshot, async (): Promise<PerformanceSnapshot> => {
    const heap = process.memoryUsage()
    const processes = app.getAppMetrics().map((metric) => ({
      type: metric.type,
      pid: metric.pid,
      cpuPercent: Math.round(metric.cpu.percentCPUUsage * 10) / 10,
      workingSetMb: kibToMb(metric.memory.workingSetSize),
      peakWorkingSetMb: kibToMb(metric.memory.peakWorkingSetSize)
    }))
    return {
      capturedAt: Date.now(),
      uptimeMs: Math.round(process.uptime() * 1000),
      mainHeapUsedMb: mb(heap.heapUsed),
      mainHeapTotalMb: mb(heap.heapTotal),
      processes
    }
  })
}
