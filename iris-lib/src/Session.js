import Gun from 'gun';
import State from './State';
import Notifications from './Notifications';
import PeerManager from './PeerManager';
import Channel from './Channel';
import util from './util';
import _ from 'lodash';
import Fuse from "fuse.js";
import localforage from 'localforage';

let key;
let myName;
let myProfilePhoto;
let latestChatLink;
let onlineTimeout;
let ourActivity;
let noFollows;
let noFollowers;
let searchIndex;
const searchableItems = {};
const channels = window.channels = {};

const DEFAULT_SETTINGS = {
  electron: {
    openAtLogin: true,
    minimizeOnClose: true
  },
  local: {
    enableWebtorrent: !util.isMobile,
    enablePublicPeerDiscovery: true,
    autoplayWebtorrent: true,
    maxConnectedPeers: util.isElectron ? 3 : 2
  }
}

const updateSearchIndex = _.throttle(() => {
  const options = {keys: ['name'], includeScore: true, includeMatches: true, threshold: 0.3};
  const values = Object.values(_.omit(searchableItems, Object.keys(State.getBlockedUsers())));
  searchIndex = new Fuse(values, options);
  State.local.get('searchIndexUpdated').put(true);
}, 2000, {leading:true});

const taskQueue = [];
setInterval(() => {
  if (taskQueue.length) {
    //console.log('taskQueue', taskQueue.length);
    taskQueue.shift()();
  }
}, 10);

const saveSearchResult = _.throttle(k => {
    State.local.get('contacts').get(k).put({followDistance: searchableItems[k].followDistance,followerCount: searchableItems[k].followers.size});
}, 1000, {leading:true});

function addFollow(callback, k, followDistance, follower) {
  if (searchableItems[k]) {
    if (searchableItems[k].followDistance > followDistance) {
      searchableItems[k].followDistance = followDistance;
    }
    searchableItems[k].followers.add(follower);
  } else {
    searchableItems[k] = {key: k, followDistance, followers: new Set(follower && [follower])};
    taskQueue.push(() => {
      State.public.user(k).get('profile').get('name').on(name => {
        searchableItems[k].name = name;
        State.local.get('contacts').get(k).get('name').put(name);
        callback && callback(k, searchableItems[k]);
      });
    });
  }
  saveSearchResult(k);
  callback && callback(k, searchableItems[k]);
  updateSearchIndex();
  updateNoFollows();
  updateNoFollowers();
}

function removeFollow(k, followDistance, follower) {
  if (searchableItems[k]) {
    searchableItems[k].followers.delete(follower);
    if (followDistance === 1) {
      State.local.get('groups').get('follows').get(k).put(false);
    }
    updateNoFollows();
    updateNoFollowers();
  }
}

const getExtendedFollowsCalled = {};
const getExtendedFollows = (callback, k, maxDepth = 3, currentDepth = 1) => {
  if (getExtendedFollowsCalled[k] <= currentDepth) {
    return;
  }
  getExtendedFollowsCalled[k] = currentDepth;

  k = k || key.pub;

  addFollow(callback, k, currentDepth - 1);

  State.public.user(k).get('follow').map().on((isFollowing, followedKey) => { // TODO: unfollow
    if (isFollowing) {
      addFollow(callback, followedKey, currentDepth, k);
      if (currentDepth < maxDepth) {
        taskQueue.push(() => getExtendedFollows(callback, followedKey, maxDepth, currentDepth + 1));
      }
    } else {
      removeFollow(followedKey, currentDepth, k);
    }
  });

  return searchableItems;
};

const updateNoFollows = _.throttle(() => {
  const v = Object.keys(searchableItems).length <= 1;
  if (v !== noFollows) {
    noFollows = v;
    State.local.get('noFollows').put(noFollows);
  }
}, 1000, {leading:true});

const updateNoFollowers = _.throttle(() => {
  const v = !(searchableItems[key.pub] && (searchableItems[key.pub].followers.size > 0));
  if (v !== noFollowers) {
    noFollowers = v;
    State.local.get('noFollowers').put(noFollowers);
  }
}, 1000, {leading:true});

function getSearchIndex() {
  return searchIndex;
}

function setOurOnlineStatus() {
  const activeRoute = window.location.hash;
  Channel.setActivity(State.public, ourActivity = 'active');
  const setActive = _.debounce(() => {
    const chat = activeRoute && channels[activeRoute.replace('#/profile/','').replace('#/chat/','')];
    if (chat && !ourActivity) {
      chat.setMyMsgsLastSeenTime();
    }
    Channel.setActivity(State.public, ourActivity = 'active');
    clearTimeout(onlineTimeout);
    onlineTimeout = setTimeout(() => Channel.setActivity(State.public, ourActivity = 'online'), 30000);
  }, 1000);
  document.addEventListener("touchmove", setActive);
  document.addEventListener("mousemove", setActive);
  document.addEventListener("keypress", setActive);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === 'visible') {
      Channel.setActivity(State.public, ourActivity = 'active');
      const chatId = location.pathname.slice(1).replace('chat/','');
      const chat = activeRoute && channels[chatId];
      if (chat) {
        chat.setMyMsgsLastSeenTime();
        Notifications.changeChatUnseenCount(chatId, 0);
      }
    } else {
      Channel.setActivity(State.public, ourActivity = 'online');
    }
  });
  setActive();
  window.addEventListener("beforeunload", () => {
    Channel.setActivity(State.public, ourActivity = null);
  });
}

function updateGroups() {
  getExtendedFollows((k, info) => {
    if (info.followDistance <= 1) {
      State.local.get('groups').get('follows').get(k).put(true);
    }
    State.local.get('groups').get('everyone').get(k).put(true);
    if (k === getPubKey()) {
      updateNoFollowers();
    }
  });
}

function login(k) {
  const shouldRefresh = !!key;
  key = k;
  localStorage.setItem('chatKeyPair', JSON.stringify(k));
  Channel.initUser(State.public, key);
  Notifications.subscribeToWebPush();
  Notifications.getWebPushSubscriptions();
  Notifications.subscribeToIrisNotifications();
  Channel.getMyChatLinks(State.public, key, undefined, chatLink => {
    State.local.get('chatLinks').get(chatLink.id).put(chatLink.url);
    latestChatLink = chatLink.url;
  });
  setOurOnlineStatus();
  Channel.getChannels(State.public, key, addChannel);
  State.public.user().get('profile').get('name').on(name => {
    if (name && typeof name === 'string') {
      myName = name;
    }
  });
  State.public.user().get('profile').get('photo').on(data => {
    myProfilePhoto = data;
  });
  Notifications.init();
  State.local.get('loggedIn').put(true);
  State.local.get('settings').once().then(settings => {
    if (!settings) {
      State.local.get('settings').put(DEFAULT_SETTINGS.local);
    } else if (settings.enableWebtorrent === undefined || settings.autoplayWebtorrent === undefined) {
      State.local.get('settings').get('enableWebtorrent').put(DEFAULT_SETTINGS.local.enableWebtorrent);
      State.local.get('settings').get('autoplayWebtorrent').put(DEFAULT_SETTINGS.local.autoplayWebtorrent);
    }
  });
  State.public.user().get('block').map().on((isBlocked, user) => {
    State.local.get('block').get(user).put(isBlocked);
    if (isBlocked) {
      delete searchableItems[user];
    }
  });
  updateGroups();
  if (shouldRefresh) {
    location.reload();
  }
  if (State.electron) {
    State.electron.get('settings').on(electron => {
      State.local.get('settings').get('electron').put(electron);
      if (electron.publicIp) {
        Object.values(channels).forEach(shareMyPeerUrl);
      }
    });
    State.electron.get('user').put(key.pub);
  }
  State.local.get('filters').get('group').once().then(v => {
    if (!v) {
      State.local.get('filters').get('group').put('follows');
    }
  });
}

async function createChatLink() {
  latestChatLink = await Channel.createChatLink(State.public, key);
}

function clearIndexedDB() {
  return new Promise(resolve => {
    const r1 = window.indexedDB.deleteDatabase('State.local');
    const r2 = window.indexedDB.deleteDatabase('radata');
    let r1done;
    let r2done;
    const check = () => {
      r1done && r2done && resolve();
    }
    r1.onerror = r2.onerror = e => console.error(e);
    //r1.onblocked = r2.onblocked = e => console.error('blocked', e);
    r1.onsuccess = () => {
      r1done = true;
      check();
    }
    r2.onsuccess = () => {
      r2done = true;
      check();
    }
  });
}

function getMyChatLink() {
  return latestChatLink || util.getProfileLink(key.pub);
}

function getKey() { return key; }
function getMyName() { return myName; }
function getMyProfilePhoto() { return myProfilePhoto; }

async function logOut() {
  if (State.electron) {
    State.electron.get('user').put(null);
  }
  // TODO: remove subscription from your channels
  if (navigator.serviceWorker) {
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg && reg.pushManager) {
      reg.active.postMessage({key: null});
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        const hash = await util.getHash(JSON.stringify(sub));
        Notifications.removeSubscription(hash);
        sub.unsubscribe && sub.unsubscribe();
      }
    }
  }
  clearIndexedDB();
  localStorage.clear();
  localforage.clear().then(() => {
    window.location.hash = '';
    window.location.href = '/';
    location.reload();
  });
}

function getPubKey() {
  return key && key.pub;
}

function loginAsNewUser(name) {
  name = name || util.generateName();
  console.log('loginAsNewUser name', name);
  return Gun.SEA.pair().then(k => {
    login(k);
    State.public.user().get('profile').put({a:null});
    State.public.user().get('profile').get('name').put(name);
    State.local.get('filters').put({a:null});
    State.local.get('filters').get('group').put('follows');
    createChatLink();
  });
}

function init(options = {}) {
  let localStorageKey = localStorage.getItem('chatKeyPair');
  if (localStorageKey) {
    login(JSON.parse(localStorageKey));
  } else if (options.autologin) {
    loginAsNewUser();
  } else {
    clearIndexedDB();
  }
  setTimeout(() => {
    State.local.get('block').map(() => {
      updateSearchIndex();
    });
    updateSearchIndex();
  });
}

const myPeerUrl = ip => `http://${ip}:8767/gun`;

async function shareMyPeerUrl(channel) {
  const myIp = await State.local.get('settings').get('electron').get('publicIp').once();
  myIp && channel.put && channel.put('my_peer', myPeerUrl(myIp));
}

function newChannel(pub, chatLink) {
  if (!pub || Object.prototype.hasOwnProperty.call(channels, pub)) {
    return;
  }
  const chat = new Channel({gun: State.public, key, chatLink, participants: pub});
  addChannel(chat);
  return chat;
}

function addChannel(chat) {
  taskQueue.push(() => {

    let pub = chat.getId();
    if (channels[pub]) { return; }
    channels[pub] = chat;
    const chatNode = State.local.get('channels').get(pub);
    chatNode.get('latestTime').on(t => {
      if (t && (!chat.latestTime || t > chat.latestTime)) {
        chat.latestTime = t;
      } else {
        // chatNode.get('latestTime').put(chat.latestTime); // omg recursion
      }
    });
    chatNode.get('theirMsgsLastSeenTime').on(t => {
      if (!t) { return; }
      const d = new Date(t);
      if (!chat.theirMsgsLastSeenDate || chat.theirMsgsLastSeenDate < d) {
        chat.theirMsgsLastSeenDate = d;
      }
    });
    chat.messageIds = chat.messageIds || {};
    chat.getLatestMsg && chat.getLatestMsg((latest, info) => {
      processMessage(pub, latest, info);
    });
    Notifications.changeChatUnseenCount(pub, 0);
    chat.notificationSetting = 'all';
    chat.onMy('notificationSetting', (val) => {
      chat.notificationSetting = val;
    });
    //$(".chat-list").append(el);
    chat.theirMsgsLastSeenTime = '';
    chat.getTheirMsgsLastSeenTime(time => {
      if (chat && time && time >= chat.theirMsgsLastSeenTime) {
        chat.theirMsgsLastSeenTime = time;
        chatNode.get('theirMsgsLastSeenTime').put(time);
      }
    });
    chat.getMyMsgsLastSeenTime(time => {
      chat.myLastSeenTime = new Date(time);
      if (chat.latest && chat.myLastSeenTime >= chat.latest.time) {
        Notifications.changeChatUnseenCount(pub, 0);
      }
      PeerManager.askForPeers(pub); // TODO: this should be done only if we have a chat history or friendship with them
    });
    chat.isTyping = false;
    chat.getTyping(isTyping => {
      chat.isTyping = isTyping;
      State.local.get('channels').get(pub).get('isTyping').put(isTyping);
    });
    chat.online = {};
    Channel.getActivity(State.public, pub, (activity) => {
      if (chat) {
        chatNode.put({theirLastActiveTime: activity && activity.lastActive, activity: activity && activity.isActive && activity.status});
        chat.activity = activity;
      }
    });
    if (chat.uuid) {
      let isDarkMode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      chat.participantProfiles = {};
      chat.on('name', v => {
        chat.name = v;
        searchableItems[chat.uuid] = {name: v, uuid: chat.uuid};
        State.local.get('channels').get(chat.uuid).get('name').put(v);
      });
      chat.on('photo', v => {
        searchableItems[chat.uuid] = searchableItems[chat.uuid] || {};
        searchableItems[chat.uuid].photo = v;
        State.local.get('channels').get(chat.uuid).get('photo').put(v)
      });
      chat.on('about', v => State.local.get('channels').get(chat.uuid).get('about').put(v));
      chat.getParticipants(participants => {
        delete participants.undefined; // TODO fix where it comes from
        if (typeof participants === 'object') {
          let keys = Object.keys(participants);
          keys.forEach((k, i) => {
            let hue = 360 / Math.max(keys.length, 2) * i; // TODO use css filter brightness
            chat.participantProfiles[k] = {permissions: participants[k], color: `hsl(${hue}, 98%, ${isDarkMode ? 80 : 33}%)`};
            State.public.user(k).get('profile').get('name').on(name => {
              chat.participantProfiles[k].name = name;
            });
          });
        }
        State.local.get('channels').get(chat.uuid).get('participants').put(participants);
      });
      chat.inviteLinks = {};
      chat.getChatLinks({callback: ({url, id}) => {
        console.log('got chat link', id, url);
        chat.inviteLinks[id] = url; // TODO use State
        State.local.get('inviteLinksChanged').put(true);
      }});
    } else {
      State.local.get('groups').get('everyone').get(pub).put(true);
      addFollow(null, pub, Infinity);
      State.public.user(pub).get('profile').get('name').on(v => State.local.get('channels').get(pub).get('name').put(v))
    }
    if (chat.put) {
      chat.onTheir('webPushSubscriptions', (s, k, from) => {
        if (!Array.isArray(s)) { return; }
        chat.webPushSubscriptions = chat.webPushSubscriptions || {};
        chat.webPushSubscriptions[from || pub] = s;
      });
      const arr = Object.values(Notifications.webPushSubscriptions);
      setTimeout(() => chat.put('webPushSubscriptions', arr), 5000);
      shareMyPeerUrl(chat);
    }
    chat.onTheir('call', call => {
      State.local.get('call').put({pub, call});
    });
    State.local.get('channels').get(pub).put({enabled:true});
    /* Disable private peer discovery, since they're not connecting anyway
    if (chat.onTheir) {
      chat.onTheir('my_peer', (url, k, from) => {
        console.log('Got private peer url', url, 'from', from);
        PeerManager.addPeer({url, from})
      });
    }
     */

  });
}

function processMessage(chatId, msg, info, onClickNotification) {
  const chat = channels[chatId];
  if (chat.messageIds[msg.time + info.from]) return;
  chat.messageIds[msg.time + info.from] = true;
  if (info) {
    msg = Object.assign(msg, info);
  }
  if (msg.invite) {
    const chatLink = `https://iris.to/?channelId=${msg.invite.group}&inviter=${chatId}`;
    newChannel(msg.invite.group, chatLink);
    return;
  }
  msg.selfAuthored = info.selfAuthored;
  State.local.get('channels').get(chatId).get('msgs').get(msg.time + (msg.from && msg.from.slice(0, 10))).put(JSON.stringify(msg));
  msg.timeObj = new Date(msg.time);
  if (!info.selfAuthored && msg.timeObj > chat.myLastSeenTime) {
    if (window.location.hash !== `#/chat/${  chatId}` || document.visibilityState !== 'visible') {
      Notifications.changeChatUnseenCount(chatId, 1);
    } else if (ourActivity === 'active') {
        chat.setMyMsgsLastSeenTime();
      }
  }
  if (!info.selfAuthored && msg.time > chat.theirMsgsLastSeenTime) {
    State.local.get('channels').get(chatId).get('theirMsgsLastSeenTime').put(msg.time);
  }
  if (!chat.latestTime || (msg.time > chat.latestTime)) {
    State.local.get('channels').get(chatId).put({
      latestTime: msg.time,
      latest: {time: msg.time, text: msg.text, selfAuthored: info.selfAuthored}
    });
  }
  // TODO: onclickNotification should do       route(`/chat/${  pub}`);
  Notifications.notifyMsg(msg, info, chatId, onClickNotification);
}

function subscribeToMsgs(pub) {
  const c = channels[pub];
  if (!c || c.subscribed) { return; }
  c.subscribed = true;
  c.getMessages((msg, info) => {
    processMessage(pub, msg, info);
  });
}

// TODO merge with State
/**
 * Utilities for Iris sessions
 */
export default {init, getKey, getPubKey, updateSearchIndex, getSearchIndex, getMyName, getMyProfilePhoto, getMyChatLink, createChatLink, ourActivity, login, logOut, addFollow, removeFollow, loginAsNewUser, DEFAULT_SETTINGS, channels, newChannel, addChannel, processMessage, subscribeToMsgs };