export const Local = {
  set(key: string, val: any) {
    uni.setStorageSync(key, val)
  },
  get(key: string) {
    return uni.getStorageSync(key)
  },
  remove(key: string) {
    uni.removeStorageSync(key)
  },
}
