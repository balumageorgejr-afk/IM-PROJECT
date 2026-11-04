import React, {
    createContext,
    useContext,
    useMemo,
    useState,
    useEffect,
} from "react";
import { createApi } from "./api";
export const roles = [
    "System Administrator",
    "Facility/Maintenance Staff",
    "Faculty / Student Organization Representative",
];
const Context = createContext(null);

function getCookie(name) {
    if (typeof document === "undefined" || !document.cookie) return null;
    const match = document.cookie.match(
        new RegExp(
            "(?:^|; )" +
                name.replace(/([.$?*|{}()[\]\\/+^])/g, "\\$1") +
                "=([^;]*)",
        ),
    );
    return match ? decodeURIComponent(match[1]) : null;
}

function setCookie(name, value, maxAgeSeconds = 900) {
    if (typeof document === "undefined") return;
    const isHttps =
        typeof window !== "undefined" && window.location?.protocol === "https:";
    document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAgeSeconds}; SameSite=Lax${isHttps ? "; Secure" : ""}`;
}

function clearCookie(name) {
    if (typeof document === "undefined") return;
    document.cookie = `${name}=; path=/; max-age=0; SameSite=Lax`;
}

export function SessionProvider({ children, apiFactory = createApi }) {
    const [user, setUser] = useState(() => {
        try {
            const cachedUser = getCookie("session_user");
            const token = getCookie("session_token");
            if (cachedUser && token) {
                const parsed = JSON.parse(cachedUser);
                if (roles.includes(parsed?.role?.roleName)) return parsed;
            }
        } catch {
            // ignore JSON parse failure
        }
        return null;
    });
    const [expires, setExpires] = useState(null);
    const [notice, setNotice] = useState("");

    const api = useMemo(() => {
        const instance = apiFactory({
            onUnauthorized: () => {
                clearCookie("session_token");
                clearCookie("session_user");
                instance.setToken(null);
                setUser(null);
                setExpires(null);
                setNotice("Your session expired. Please sign in again.");
            },
        });
        const savedToken = getCookie("session_token");
        if (savedToken) {
            instance.setToken(savedToken);
        }
        return instance;
    }, [apiFactory]);

    const logout = () => {
        clearCookie("session_token");
        clearCookie("session_user");
        api.setToken(null);
        setUser(null);
        setExpires(null);
        setNotice("You have signed out.");
        api.request("/auth/logout", {
            method: "POST",
            publicRequest: true,
        }).catch(() => {});
    };

    useEffect(() => {
        const savedToken = getCookie("session_token");
        if (!savedToken) return;
        api.request("/auth/me")
            .then((data) => {
                if (roles.includes(data.user?.role?.roleName)) {
                    setUser(data.user);
                    setExpires(Date.now() + 900 * 1000);
                    setCookie("session_user", JSON.stringify(data.user), 900);
                } else {
                    clearCookie("session_token");
                    clearCookie("session_user");
                    api.setToken(null);
                    setUser(null);
                }
            })
            .catch(() => {
                // If unauthorized, onUnauthorized already cleans up
            });
    }, [api]);

    useEffect(() => {
        if (!expires) return;
        const timer = setTimeout(
            () => {
                clearCookie("session_token");
                clearCookie("session_user");
                api.setToken(null);
                setUser(null);
                setExpires(null);
                setNotice("Your session expired. Please sign in again.");
            },
            Math.max(0, expires - Date.now()),
        );
        return () => clearTimeout(timer);
    }, [api, expires]);

    async function login(email, password) {
        const data = await api.request("/auth/login", {
            method: "POST",
            body: { email, password },
            publicRequest: true,
        });
        if (typeof data.token !== "string" || !data.token)
            throw Error("Unable to establish a session.");
        api.setToken(data.token);
        try {
            const profile = await api.request("/auth/me");
            if (!roles.includes(profile.user?.role?.roleName))
                throw Error("Your role cannot access this application.");
            const maxAge = Math.min(Number(data.expiresIn) || 900, 900);
            setCookie("session_token", data.token, maxAge);
            setCookie("session_user", JSON.stringify(profile.user), maxAge);
            setUser(profile.user);
            setExpires(Date.now() + maxAge * 1000);
            setNotice("");
        } catch (error) {
            clearCookie("session_token");
            clearCookie("session_user");
            api.setToken(null);
            throw error;
        }
    }
    return (
        <Context.Provider value={{ user, api, login, logout, notice }}>
            {children}
        </Context.Provider>
    );
}
export function useSession() {
    return useContext(Context);
}
