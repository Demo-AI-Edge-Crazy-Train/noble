//
// This package implements an asynchronous Queue based on Promise objects.
//
// The code is based from https://stackoverflow.com/questions/53540348/js-async-await-tasks-queue
//

/**
 * Creates a new empty AsyncQueue.
 *
 * @returns {AsyncQueue} empty queue object
 */
const AsyncQueue = function () {
    this._pendingPromise = false;
    this._tasks = [];
};

/**
 * Returns the next task to process and removes it from the queue.
 *
 * @returns {object} next task to process
 */
AsyncQueue.prototype._getNextTask = function () {
    return this._tasks.shift();
};

/**
 * Adds a task to the queue.
 *
 * @param {object} task task object
 */
AsyncQueue.prototype._addTask = function (task) {
    this._tasks.push(task);
};

/**
 * Returns the number of tasks waiting in the queue.
 *
 * @returns {int} number of tasks waiting in the queue.
 */
AsyncQueue.prototype.size = function () {
    return this._tasks.length;
};

/**
 * Enqueues a task represented by a function onto this queue.
 *
 * @param {function} action the task to enqueue
 * @returns {Promise} asynchronous operation of adding the task
 */
AsyncQueue.prototype.enqueue = function (action) {
    return new Promise((resolve, reject) => {
        this._addTask({ action, resolve, reject });
        this.dequeue();
    });
};

/**
 * Dequeues a task from this queue and processes it.
 *
 * @returns {boolean} true if a task has been processed. false if there is no more
 *                    task to process or if a task is currently being executed.
 */
AsyncQueue.prototype.dequeue = async function () {
    if (this._pendingPromise) {
        return false;
    }
  
    let task = this._getNextTask();
    if (task === undefined) {
        return false;
    }

    try {
      this._pendingPromise = true;

      let payload = await task.action(this);

      this._pendingPromise = false;
      task.resolve(payload);
    } catch (e) {
      this._pendingPromise = false;
      task.reject(e);
    } finally {
      this.dequeue();
    }

    return true;
};

module.exports = AsyncQueue;
