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
export function SessionProvider({ children, apiFactory = createApi }) {
    const [user, setUser] = useState(null),
        [expires, setExpires] = useState(null),
        [notice, setNotice] = useState("");
    const api = useMemo(
        () =>
            apiFactory({
                onUnauthorized: () => {
                    api.setToken(null);
                    setUser(null);
                    setExpires(null);
                    setNotice("Your session expired. Please sign in again.");
                },
            }),
        [apiFactory],
    );
    const logout = () => {
        api.setToken(null);
        setUser(null);
        setExpires(null);
        setNotice("You have signed out.");
    };
    useEffect(() => {
        if (!expires) return;
        const timer = setTimeout(
            () => {
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
            setUser(profile.user);
            setExpires(
                Date.now() +
                    Math.min(Number(data.expiresIn) || 900, 900) * 1000,
            );
            setNotice("");
        } catch (error) {
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
