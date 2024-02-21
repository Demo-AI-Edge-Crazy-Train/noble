const AsyncQueue = function () {
    this._pendingPromise = false;
    this._tasks = [];
};

AsyncQueue.prototype._getNextTask = function () {
    return this._tasks.shift();
};

AsyncQueue.prototype._addTask = function (task) {
    this._tasks.push(task);
};

AsyncQueue.prototype.size = function () {
    return this._tasks.length;
};

AsyncQueue.prototype.enqueue = function (action) {
    return new Promise((resolve, reject) => {
        this._addTask({ action, resolve, reject });
        this.dequeue();
    });
};

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
