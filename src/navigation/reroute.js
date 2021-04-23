import CustomEvent from "custom-event";
import { isStarted } from "../start.js";
import { toLoadPromise } from "../lifecycles/load.js";
import { toBootstrapPromise } from "../lifecycles/bootstrap.js";
import { toMountPromise } from "../lifecycles/mount.js";
import { toUnmountPromise } from "../lifecycles/unmount.js";
import {
  getAppStatus,
  getAppChanges,
  getMountedApps,
} from "../applications/apps.js";
import {
  callCapturedEventListeners,
  navigateToUrl,
} from "./navigation-events.js";
import { toUnloadPromise } from "../lifecycles/unload.js";
import {
  toName,
  shouldBeActive,
  NOT_MOUNTED,
  MOUNTED,
  NOT_LOADED,
  SKIP_BECAUSE_BROKEN,
} from "../applications/app.helpers.js";
import { assign } from "../utils/assign.js";
import { isInBrowser } from "../utils/runtime-environment.js";

let appChangeUnderway = false,
  peopleWaitingOnAppChange = [],
  currentUrl = isInBrowser && window.location.href;

export function triggerAppChange() {
  // Call reroute with no arguments, intentionally
  return reroute();
}

export function reroute(pendingPromises = [], eventArguments) {
  // 指明reroute在一次执行周期中，其他reroute将被挂起，直到本次reroute递归调用才予以执行
  if (appChangeUnderway) {
    return new Promise((resolve, reject) => {
      peopleWaitingOnAppChange.push({
        resolve,
        reject,
        eventArguments,
      });
    });
  }

  // 获取状态区分的子应用数组
  const {
    appsToUnload,
    appsToUnmount,
    appsToLoad,
    appsToMount,
  } = getAppChanges();

  let appsThatChanged,
    navigationIsCanceled = false,
    oldUrl = currentUrl,
    newUrl = (currentUrl = window.location.href);

  // 执行start启动时，走这里
  if (isStarted()) {
    appChangeUnderway = true;
    appsThatChanged = appsToUnload.concat(
      appsToLoad,
      appsToUnmount,
      appsToMount
    );
    return performAppChanges();
  } else {
    // registerApplication走这里
    appsThatChanged = appsToLoad;
    return loadApps();
  }

  function cancelNavigation() {
    navigationIsCanceled = true;
  }

  function loadApps() {
    return Promise.resolve().then(() => {
      // 加载子应用
      // status：NOT_LOADED => LOADING_SOURCE_CODE => NOT_BOOTSTRAPPED
      const loadPromises = appsToLoad.map(toLoadPromise);

      return (
        Promise.all(loadPromises)
          .then(callAllEventListeners)
          // there are no mounted apps, before start() is called, so we always return []
          .then(() => [])
          .catch((err) => {
            callAllEventListeners();
            throw err;
          })
      );
    });
  }

  function performAppChanges() {
    return Promise.resolve().then(() => {
      // https://github.com/single-spa/single-spa/issues/545
      /**
       * 创建并触发自定义事件，详情见官网 https://zh-hans.single-spa.js.org/docs/api/#custom-events
       * 可通过window.addEventListener('single-spa:...',()=>{})监听该自定义事件
       */
      window.dispatchEvent(
        new CustomEvent(
          appsThatChanged.length === 0
            ? "single-spa:before-no-app-change"
            : "single-spa:before-app-change",
          getCustomEventDetail(true)
        )
      );

      window.dispatchEvent(
        new CustomEvent(
          "single-spa:before-routing-event",
          getCustomEventDetail(true, { cancelNavigation })
        )
      );

      if (navigationIsCanceled) {
        window.dispatchEvent(
          new CustomEvent(
            "single-spa:before-mount-routing-event",
            getCustomEventDetail(true)
          )
        );
        finishUpAndReturn();
        navigateToUrl(oldUrl);
        return;
      }
      // 重点来了
      /**
       * 移除子应用，执行unload钩子函数
       * 清除子应用的bootstrap、mount、unmount、unload，返回Promise
       * 下次激活时需要重头走加载启动挂载逻辑
       * status：NOT_MOUNTED => UNLOADING => NOT_LOADED
       */
      const unloadPromises = appsToUnload.map(toUnloadPromise);

      /**
       * 卸载子应用，执行unmount钩子函数
       * 下次激活时只需要重新挂载即可
       * status：MOUNTED => UNMOUNTING => NOT_MOUNTED
       */
      const unmountUnloadPromises = appsToUnmount
        .map(toUnmountPromise)
        .map((unmountPromise) => unmountPromise.then(toUnloadPromise));

      const allUnmountPromises = unmountUnloadPromises.concat(unloadPromises);

      const unmountAllPromise = Promise.all(allUnmountPromises);

      unmountAllPromise.then(() => {
        window.dispatchEvent(
          new CustomEvent(
            "single-spa:before-mount-routing-event",
            getCustomEventDetail(true)
          )
        );
      });

      /* We load and bootstrap apps while other apps are unmounting, but we
       * wait to mount the app until all apps are finishing unmounting
       */
      // 待加载的子应用：加载 => 启动 => 挂载
      const loadThenMountPromises = appsToLoad.map((app) => {
        // status：NOT_LOADED => LOADING_SOURCE_CODE => NOT_BOOTSTRAPPED
        return toLoadPromise(app).then((app) =>
          tryToBootstrapAndMount(app, unmountAllPromise)
        );
      });

      /* These are the apps that are already bootstrapped and just need
       * to be mounted. They each wait for all unmounting apps to finish up
       * before they mount.
       */
      // 待挂载的子应用：挂载
      const mountPromises = appsToMount
        // 过滤掉待加载的应用
        .filter((appToMount) => appsToLoad.indexOf(appToMount) < 0)
        .map((appToMount) => {
          return tryToBootstrapAndMount(appToMount, unmountAllPromise);
        });

      return unmountAllPromise
        .catch((err) => {
          callAllEventListeners();
          throw err;
        })
        .then(() => {
          /* Now that the apps that needed to be unmounted are unmounted, their DOM navigation
           * events (like hashchange or popstate) should have been cleaned up. So it's safe
           * to let the remaining captured event listeners to handle about the DOM event.
           */
          callAllEventListeners();

          return Promise.all(loadThenMountPromises.concat(mountPromises))
            .catch((err) => {
              pendingPromises.forEach((promise) => promise.reject(err));
              throw err;
            })
            .then(finishUpAndReturn);
        });
    });
  }

  function finishUpAndReturn() {
    // 获取当前激活的应用
    const returnValue = getMountedApps();
    pendingPromises.forEach((promise) => promise.resolve(returnValue));

    try {
      const appChangeEventName =
        appsThatChanged.length === 0
          ? "single-spa:no-app-change"
          : "single-spa:app-change";
      window.dispatchEvent(
        new CustomEvent(appChangeEventName, getCustomEventDetail())
      );
      window.dispatchEvent(
        new CustomEvent("single-spa:routing-event", getCustomEventDetail())
      );
    } catch (err) {
      /* We use a setTimeout because if someone else's event handler throws an error, single-spa
       * needs to carry on. If a listener to the event throws an error, it's their own fault, not
       * single-spa's.
       */
      setTimeout(() => {
        throw err;
      });
    }

    /* Setting this allows for subsequent calls to reroute() to actually perform
     * a reroute instead of just getting queued behind the current reroute call.
     * We want to do this after the mounting/unmounting is done but before we
     * resolve the promise for the `reroute` function.
     */
    // reroute单次执行结束，无挂起的reroute时，调用reroute将直接执行
    appChangeUnderway = false;

    // 手动触发被挂起的reroute
    if (peopleWaitingOnAppChange.length > 0) {
      /* While we were rerouting, someone else triggered another reroute that got queued.
       * So we need reroute again.
       */
      const nextPendingPromises = peopleWaitingOnAppChange;
      peopleWaitingOnAppChange = [];
      reroute(nextPendingPromises);
    }

    return returnValue;
  }

  /* We need to call all event listeners that have been delayed because they were
   * waiting on single-spa. This includes haschange and popstate events for both
   * the current run of performAppChanges(), but also all of the queued event listeners.
   * We want to call the listeners in the same order as if they had not been delayed by
   * single-spa, which means queued ones first and then the most recent one.
   */
  /**
   * 执行应用中原本注册的hashchange、popstate事件
   * 因为single-spa会监听hashchange、popstate事件，在应用切换的时候，重新调用reroute，进行应用的卸载加载
   * 应用原本的hashchange、popstate事件需要在应用加载后执行
   */
  function callAllEventListeners() {
    pendingPromises.forEach((pendingPromise) => {
      callCapturedEventListeners(pendingPromise.eventArguments);
    });

    callCapturedEventListeners(eventArguments);
  }

  // 触发自定义事件时传出属性
  function getCustomEventDetail(isBeforeChanges = false, extraProperties) {
    const newAppStatuses = {};
    const appsByNewStatus = {
      // for apps that were mounted
      [MOUNTED]: [],
      // for apps that were unmounted
      [NOT_MOUNTED]: [],
      // apps that were forcibly unloaded
      [NOT_LOADED]: [],
      // apps that attempted to do something but are broken now
      [SKIP_BECAUSE_BROKEN]: [],
    };

    if (isBeforeChanges) {
      appsToLoad.concat(appsToMount).forEach((app, index) => {
        addApp(app, MOUNTED);
      });
      appsToUnload.forEach((app) => {
        addApp(app, NOT_LOADED);
      });
      appsToUnmount.forEach((app) => {
        addApp(app, NOT_MOUNTED);
      });
    } else {
      appsThatChanged.forEach((app) => {
        addApp(app);
      });
    }

    const result = {
      detail: {
        newAppStatuses,
        appsByNewStatus,
        totalAppChanges: appsThatChanged.length,
        originalEvent: eventArguments?.[0],
        oldUrl,
        newUrl,
        navigationIsCanceled,
      },
    };

    if (extraProperties) {
      assign(result.detail, extraProperties);
    }

    return result;

    function addApp(app, status) {
      const appName = toName(app);
      status = status || getAppStatus(appName);
      newAppStatuses[appName] = status;
      const statusArr = (appsByNewStatus[status] =
        appsByNewStatus[status] || []);
      statusArr.push(appName);
    }
  }
}

/**
 * Let's imagine that some kind of delay occurred during application loading.
 * The user without waiting for the application to load switched to another route,
 * this means that we shouldn't bootstrap and mount that application, thus we check
 * twice if that application should be active before bootstrapping and mounting.
 * https://github.com/single-spa/single-spa/issues/524
 */
/**
 * 
 * 如果用户在没有等待子应用加载的情况下切换到另一个路由
 * 我们不应该加载和挂载该子应用，因此我们在加载和挂载之前检查两次该子应用是否出于激活状态
 */
function tryToBootstrapAndMount(app, unmountAllPromise) {
  // 判断是否出于激活状态
  if (shouldBeActive(app)) {
    // 启动
    // status：NOT_BOOTSTRAPPED => BOOTSTRAPPING => NOT_MOUNTED
    return toBootstrapPromise(app).then((app) =>
      // 先卸载再挂载
      unmountAllPromise.then(() =>
        // 挂载
        // status：NOT_MOUNTED => MOUNTED
        shouldBeActive(app) ? toMountPromise(app) : app
      )
    );
  } else {
    return unmountAllPromise.then(() => app);
  }
}
