import { EventEmitter } from 'node:events';

export class EventBus {
  private readonly emitter = new EventEmitter();

  publish(event: string, payload: unknown): void {
    this.emitter.emit(event, payload);
  }

  subscribe(event: string, handler: (payload: unknown) => void): void {
    this.emitter.on(event, handler);
  }
}
