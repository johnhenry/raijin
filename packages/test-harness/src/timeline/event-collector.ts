/**
 * EventCollector — simple event aggregation for test timeline building.
 */

export interface TimelineEvent {
  timestamp: number
  nodeId: string
  category: string
  type: string
  data: Record<string, unknown>
}

export class EventCollector {
  #events: TimelineEvent[] = []
  #startTime = Date.now()

  /**
   * Record an event.
   */
  record(nodeId: string, category: string, type: string, data: Record<string, unknown>): void {
    this.#events.push({
      timestamp: Date.now() - this.#startTime,
      nodeId,
      category,
      type,
      data,
    })
  }

  /**
   * Get all recorded events in order.
   */
  getEvents(): TimelineEvent[] {
    return [...this.#events]
  }

  /**
   * Get events filtered by category.
   */
  getByCategory(category: string): TimelineEvent[] {
    return this.#events.filter(e => e.category === category)
  }

  /**
   * Get events filtered by node.
   */
  getByNode(nodeId: string): TimelineEvent[] {
    return this.#events.filter(e => e.nodeId === nodeId)
  }

  /**
   * Total event count.
   */
  get size(): number {
    return this.#events.length
  }

  /**
   * Clear all events.
   */
  clear(): void {
    this.#events = []
    this.#startTime = Date.now()
  }
}
