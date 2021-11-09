import axios from "axios"
import React, { useEffect, useState } from "react"
import type { RecoilState } from "recoil"
import { atom, useRecoilValue, useRecoilState, useSetRecoilState } from "recoil"
import YAML from "yaml"
import { Atom, InitPlugin } from "../@types/plugin"
import { SayaDefinition } from "../miraktest-annict/types"
import { DPlayerCommentPayload } from "../miraktest-dplayer/types"
import { trimCommentForFlow } from "../miraktest-saya/comment"
import { NicoCommentChat } from "../miraktest-zenza/types"
import { useRefFromState, wait } from "../shared/utils"
import tailwind from "../tailwind.scss"
import { parseMail } from "./parser"
import { IdealChat, NicoLogComment, NicoSetting } from "./types"

/**
 * MirakTest Nico Plugin
 * ニコニコ実況からコメントを取得し、コメントレンダラに流し込むプラグイン
 * Impl copied from ../miraktest-miyou
 */

const _id = "io.github.ci7lus.miraktest-plugins.nico"
const prefix = "plugins.ci7lus.nico"
const meta = {
  id: _id,
  name: "ニコニコ実況",
  author: "ci7lus",
  version: "0.0.1",
  description:
    "ニコニコ実況からコメントを取得するプラグインです。ZenzaかDPlayerプラグインが必要です。",
}

const main: InitPlugin = {
  renderer: ({ atoms }) => {
    const settingAtom = atom<NicoSetting>({
      key: `${prefix}.setting`,
      default: {
        isLiveEnabled: true,
        isTimeshiftEnabled: true,
      },
    })

    let zenzaCommentAtom: RecoilState<NicoCommentChat> | null = null
    let dplayerCommentAtom: RecoilState<DPlayerCommentPayload> | null = null

    return {
      ...meta,
      exposedAtoms: [],
      sharedAtoms: [
        {
          type: "atom",
          atom: settingAtom,
        },
      ],
      storedAtoms: [
        {
          type: "atom",
          atom: settingAtom,
        },
      ],
      setup({ plugins }) {
        const zenza = plugins.find(
          (plugin) => plugin.id === "io.github.ci7lus.miraktest-plugins.zenza"
        )
        if (zenza) {
          const family = zenza.exposedAtoms.find(
            (atom): atom is Atom<NicoCommentChat> =>
              atom.type === "atom" &&
              atom.atom.key === "plugins.ci7lus.zenza.comment"
          )
          if (family) {
            zenzaCommentAtom = family.atom
          }
        }
        const dplayer = plugins.find(
          (plugin) => plugin.id === "io.github.ci7lus.miraktest-plugins.dplayer"
        )
        if (dplayer) {
          const family = dplayer.exposedAtoms.find(
            (atom): atom is Atom<DPlayerCommentPayload> =>
              atom.type === "atom" &&
              atom.atom.key === "plugins.ci7lus.dplayer.comment"
          )
          if (family) {
            dplayerCommentAtom = family.atom
          }
        }
      },
      components: [
        {
          id: `${prefix}.onPlayer`,
          position: "onPlayer",
          component: () => {
            const setting = useRecoilValue(settingAtom)
            const service = useRecoilValue(atoms.contentPlayerServiceSelector)
            const program = useRecoilValue(atoms.contentPlayerProgramSelector)
            const isSeekable = useRecoilValue(
              atoms.contentPlayerIsSeekableSelector
            )
            const time = useRecoilValue(atoms.contentPlayerPlayingTimeSelector)
            const timeRef = useRefFromState(time)
            const setZenzaComment = zenzaCommentAtom
              ? useSetRecoilState(zenzaCommentAtom)
              : null
            const setDplayerComment = dplayerCommentAtom
              ? useSetRecoilState(dplayerCommentAtom)
              : null

            const [sayaDefinition, setSayaDefinition] =
              useState<SayaDefinition | null>(null)
            useEffect(() => {
              axios
                .get<string>(
                  "https://raw.githack.com/SlashNephy/saya/dev/docs/definitions.yml",
                  {
                    responseType: "text",
                  }
                )
                .then((r) => {
                  const parsed: SayaDefinition = YAML.parse(r.data)
                  setSayaDefinition(parsed)
                })
                .catch(console.error)
            }, [])

            const [jk, setJk] = useState<number | null>(null)
            useEffect(() => {
              if (!sayaDefinition) {
                return
              }
              const chDef = sayaDefinition.channels.find((channel) =>
                channel.serviceIds.includes(service?.serviceId || 0)
              )
              setJk(chDef?.nicojkId || null)
            }, [sayaDefinition, service])

            const [comments, setComments] = useState<IdealChat[]>([])
            const [log, setLog] = useState<string[]>([])
            const [lastStartAt, setLastStartAt] = useState<number>(0)

            const [period, setPeriod] = useState<
              [number | null, number | null]
            >([null, null])
            useEffect(() => {
              if (!program?.duration || !isSeekable) {
                setPeriod([null, null])
                return
              }
              const pos = Math.floor((time + 5000) / 600_000) // 10分
              const start = program.startAt + pos * 600_000
              const endAt = program.startAt + program.duration
              const end = Math.min(start + 600_000, endAt)
              if (lastStartAt !== program.startAt) {
                setLastStartAt(program.startAt)
                setComments([])
              }
              setPeriod([start, end])
            }, [program, time])

            useEffect(() => {
              const [start, end] = period
              if (
                setting.isTimeshiftEnabled !== true ||
                jk === null ||
                !start ||
                !end
              ) {
                return
              }
              const cacheKey = period.join(",")
              if (log.includes(cacheKey)) {
                return
              }
              console.info("コメントの取得を開始します", service)

              axios
                .get<
                  { packet: { chat: NicoLogComment }[] } | { error: string }
                >(`https://jikkyo.tsukumijima.net/api/kakolog/jk${jk}`, {
                  params: {
                    format: "json",
                    starttime: Math.floor(start / 1000),
                    endtime: Math.floor(end / 1000),
                  },
                })
                .then((r) => {
                  const { data } = r
                  if ("error" in data) {
                    console.error(data.error)
                    return
                  }
                  setComments((prev) =>
                    [
                      ...prev,
                      ...data.packet.map((packet) => {
                        const { chat } = packet
                        const date = parseInt(chat.date)
                        const date_usec = parseInt(chat.date_usec)
                        return {
                          ...packet.chat,
                          no: parseInt(chat.no),
                          date,
                          date_usec,
                          vpos: parseInt(chat.vpos),
                          time: date * 1000 + date_usec / 1000,
                        }
                      }),
                    ].sort((a, b) => a.time - b.time)
                  )
                  setLog((prev) => [...prev, cacheKey])
                })
                .catch((e) => {
                  console.error(e)
                })
            }, [jk, ...period])

            useEffect(() => {
              if (!program?.startAt || !isSeekable || !time) {
                return
              }
              let isCanceled = false
              ;(async () => {
                let lastTime = timeRef.current
                let index = 0
                while (index < comments.length) {
                  if (isCanceled) {
                    break
                  }
                  const comment = comments[index]

                  const time = timeRef.current

                  if (time < lastTime) {
                    console.info("巻き戻しを検知、インデックスを0に戻します")
                    lastTime = time
                    index = 0
                    continue
                  }
                  lastTime = time

                  if (comment.time < program.startAt + time - 2000) {
                    index++
                    continue
                  }
                  if (program.startAt + timeRef.current - 1000 < comment.time) {
                    await wait(500)
                    continue
                  }
                  const text = trimCommentForFlow(comment.content)
                  if (text.length === 0) {
                    continue
                  }
                  if (setZenzaComment) {
                    setZenzaComment({
                      ...comment,
                      thread: 1,
                      anonymity: 1,
                      content: text,
                    })
                  }
                  if (setDplayerComment) {
                    const { color, position } = parseMail(comment.mail)
                    setDplayerComment({
                      source: `ニコニコ実況過去ログ [${comment.thread}]`,
                      sourceUrl: `https://jikkyo.tsukumijima.net/api/kakolog/jk${jk}`,
                      time: comment.date,
                      timeMs: comment.date_usec,
                      author: comment.user_id,
                      text,
                      no: comment.no,
                      color: color,
                      type: position,
                      commands: [],
                    })
                  }
                  index++
                }
              })()
              return () => {
                isCanceled = true
              }
            }, [comments])

            return <></>
          },
        },
        {
          id: `${prefix}.settings`,
          position: "onSetting",
          label: meta.name,
          component: () => {
            const [setting, setSetting] = useRecoilState(settingAtom)
            const [mail /*, setMail*/] = useState(setting.mail)
            const [pass /*, _setPass*/] = useState(setting.pass)
            const [isLiveEnabled] = useState(setting.isLiveEnabled)
            const [isTimeshiftEnabled, setIsTimeshiftEnabled] = useState(
              setting.isTimeshiftEnabled
            )
            //const [isHidden, setIsHidden] = useState(true)

            return (
              <>
                <style>{tailwind}</style>
                <form
                  className="m-4"
                  onSubmit={(e) => {
                    e.preventDefault()
                    setSetting({
                      mail,
                      pass,
                      isLiveEnabled,
                      isTimeshiftEnabled,
                    })
                  }}
                >
                  <label className="block mt-4">
                    <span>有効</span>
                    <input
                      type="checkbox"
                      className="block mt-2 form-checkbox"
                      checked={isTimeshiftEnabled || false}
                      onChange={() =>
                        setIsTimeshiftEnabled((enabled) => !enabled)
                      }
                    />
                  </label>
                  {/*<label className="mt-4 block">
                    <span>モリタポのメールアドレス</span>
                    <input
                      type="text"
                      placeholder="miyou@miyou.tv"
                      className="block mt-2 form-input rounded-md w-full text-gray-900"
                      value={mail || ""}
                      onChange={(e) => setMail(e.target.value)}
                    />
                  </label>
                  <label className="mt-4 block">
                    <span>モリタポのパスワード</span>
                    <input
                      type={isHidden ? "password" : "text"}
                      placeholder="*****"
                      className="block mt-2 form-input rounded-md w-full text-gray-900"
                      value={pass || ""}
                      onChange={(e) => setPass(e.target.value)}
                      onFocus={() => setIsHidden(false)}
                      onBlur={() => setIsHidden(true)}
                    />
                    </label>*/}
                  <button
                    type="submit"
                    className="bg-gray-100 text-gray-800 p-2 px-2 my-4 rounded-md focus:outline-none cursor-pointer"
                  >
                    保存
                  </button>
                </form>
              </>
            )
          },
        },
      ],
      destroy() {
        return
      },
      windows: {},
    }
  },
}

export default main