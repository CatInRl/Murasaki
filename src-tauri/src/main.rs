// 发布模式下不显示控制台窗口（Windows GUI 程序标配）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    murasaki_lib::run()
}
