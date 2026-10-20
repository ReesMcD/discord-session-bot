/**
 * When to stop trying to reconnect: after too many failed attempts *in a row*. A successful
 * reconnect starts the count again, so a long session can ride out any number of separate drops.
 */
export class ReconnectBudget {
  /** Every reconnect over the whole recording, for the status display. */
  total = 0;
  private inARow = 0;

  constructor(private readonly maxInARow = 10) {}

  /** Records an attempt; false means give up. */
  attempt(): boolean {
    this.total++;
    this.inARow++;
    return this.inARow <= this.maxInARow;
  }

  connected(): void {
    this.inARow = 0;
  }
}
