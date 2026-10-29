-- 文小舟 卸载工具
--
-- 双击运行 → 确认弹窗 → 一次系统密码 → 全清干净
-- 由 build-dmg.sh 用 osacompile 编成 /Applications/文小舟 卸载.app
--
-- 关键设计:
--   1. AppleScript 在用户上下文跑,先拿到当前用户的 username/uid/home
--   2. 把这三个值通过环境变量传给 with administrator privileges 启动的
--      bash 脚本(脚本本身跑在 root,$HOME 已经变成 /var/root 不能再用)
--   3. 一次提权完成全部清理(用户域 + 系统域),用户只输一次密码

on run
    set userName to short user name of (system info)
    set userUid to user ID of (system info)
    set userHome to POSIX path of (path to home folder)
    set appPath to POSIX path of (path to me)
    set cleanupScript to appPath & "Contents/Resources/uninstall-all.sh"

    -- 第一步: 确认
    try
        display dialog "确定卸载「文小舟」吗?

会清理:
  • 后台 LaunchAgent (com.lingxi-ai.server)
  • WPS 三宿主的 publish.xml 注册
  • ~/.lingxi-ai/ (用户配置 + 变体)
  • /Library/Application Support/LingxiAI/ (安装目录)
  • pkgutil 安装记录" buttons {"取消", "卸载"} default button "卸载" cancel button "取消" with icon caution with title "文小舟 卸载工具"
    on error number -128
        return
    end try

    -- 第二步: 一次提权干完所有事(包括把 .app 自身删了)
    try
        set userInfo to "TARGET_USER=" & quoted form of userName & " " & ¬
                       "TARGET_HOME=" & quoted form of userHome & " " & ¬
                       "TARGET_UID=" & quoted form of (userUid as string) & " " & ¬
                       "SELF_APP=" & quoted form of appPath
        do shell script userInfo & " bash " & quoted form of cleanupScript ¬
            with administrator privileges ¬
            with prompt "卸载文小舟 需要管理员密码来清理 /Library/Application Support/"

        -- 注意:执行到这里时 .app 本体已被 rm,但 applet 进程已 mmap 到内存继续跑,
        -- display dialog 不需要访问 .app 资源,所以仍能正常弹窗
        display dialog "文小舟 已卸载干净 🎉

  • 重新打开 WPS 后插件不再加载
  • 卸载工具 (.app) 也已经自动删除
  • 已配置的 provider / Token 在 WPS 的 localStorage,
    若想彻底清除,清空 WPS 缓存即可" buttons {"完成"} default button "完成" with icon note with title "文小舟 卸载工具"
    on error errMsg number errNum
        if errNum is -128 then
            -- 用户在密码框点了取消
            return
        end if
        display dialog "卸载过程出错:

" & errMsg & "

可手动执行下面命令:
  sudo rm -rf ~/.lingxi-ai
  sudo rm -rf '/Library/Application Support/LingxiAI'
  sudo pkgutil --forget com.lingxi-ai.installer" buttons {"OK"} with icon stop with title "文小舟 卸载工具"
    end try
end run
